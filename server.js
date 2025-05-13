//https://backend-full-openai.vercel.app/api/streaming-openai-tts

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { OpenAI } = require("openai");
const multer = require("multer");
const FormData = require("form-data");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

const fs = require("fs");
const path = require("path");
const { VertexAI } = require("@google-cloud/vertexai");

// scrivi la chiave JSON in /tmp e punta lì
const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const keyPath = path.join("/tmp", "sa-key.json");
fs.writeFileSync(keyPath, saKey);
process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;


const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_SIMULATEUR
});


const vertexAI = new VertexAI({
    project: process.env.GCLOUD_PROJECT,
    location: process.env.VERTEX_LOCATION
});
const vertexModel = vertexAI.getGenerativeModel({
    model: process.env.VERTEX_MODEL_ID,
    generationConfig: { maxOutputTokens: 512 }
});


// Timeout for OpenAI on Vercel waiting for the response from OpenAI
const API_TIMEOUT = 320000; // 5 min

// Configure axios with a timeout for OpenAI
const axiosInstance = axios.create({
    timeout: API_TIMEOUT // Set the maximum timeout for all requests to OpenAI
});

async function streamAssistant(assistantId, messages, userId, res) {
    // 1. thread usa‑e‑getta con i messaggi che gli passi
    const thread = await openai.beta.threads.create({ messages });

    // 2. avvia il run dell’assistant in streaming
    const run = await openai.beta.threads.runs.createAndStream(
        thread.id,
        { assistant_id: assistantId, stream: true, user: userId }
    );

    // 3. inoltra i delta.content come SSE al client
    for await (const event of run) {
        const delta = event.data?.delta?.content;
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }

    // 4. chiudi lo stream
    res.write("data: [DONE]\n\n");
    res.end();
}

// 1️⃣ GESTIONE DELL’ENDPOINT WHISPER in testa
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    // DEBUG: vedi se il file arriva
    console.log("🔹 /api/transcribe, req.file:", req.file?.originalname, req.file?.size);

    const apiKey = process.env.OPENAI_API_KEY_SIMULATEUR;
    if (!apiKey) {
        return res.status(500).json({ error: "OpenAI API key missing" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "No audio file uploaded" });
    }

    try {
        const form = new FormData();
        form.append("file", req.file.buffer, { filename: req.file.originalname });
        form.append("model", "whisper-1");

        const response = await axios.post(
            "https://api.openai.com/v1/audio/transcriptions",
            form,
            { headers: { ...form.getHeaders(), "Authorization": `Bearer ${apiKey}` } }
        );

        console.log("🎉 Whisper response:", response.data);
        return res.json(response.data);

    } catch (err) {
        const details = err.response?.data || err.message;
        console.error("❌ Whisper transcription error details:", details);
        return res.status(err.response?.status || 500)
            .json({ error: "Transcription failed", details });
    }
});

// Endpoint to call different APIs chatbot and elevenlab
app.post("/api/:service", upload.none(), async (req, res) => {
    try {
        const { service } = req.params;
        console.log("🔹 Servizio ricevuto:", service);
        console.log("🔹 Dati ricevuti:", JSON.stringify(req.body));
        let apiKey, apiUrl;

        if (service === "azureOpenaiSimulateur") {
            const apiKey = process.env.AZURE_OPENAI_KEY_SIMULATEUR;
            const endpoint = process.env.AZURE_OPENAI_ENDPOINT_SIMULATEUR;
            const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_SIMULATEUR;
            const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

            const apiUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

            const response = await axiosInstance.post(apiUrl, req.body, {
                headers: {
                    "api-key": apiKey,
                    "Content-Type": "application/json"
                },
                responseType: 'stream'
            });

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");

            response.data.on('data', (chunk) => {
                res.write(chunk);
            });

            response.data.on('end', () => {
                res.end();
            });

            response.data.on('error', (error) => {
                console.error("Error in stream:", error);
                res.end();
            });

            return;
        }
        else if (service === "vertexChat") {
            // CORS (se non già fatto globalmente)
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");

            const { messages } = req.body;

            // 1️⃣ Prepara contents per Gemini multimodale
            const contents = messages.map(m => ({
                role: m.role,
                parts: [{ text: m.content }]
            }));

            try {
                // 2️⃣ Header SSE
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.flushHeaders();

                // 3️⃣ Richiesta streaming (attendi la risposta iniziale)
                const streamingResp = await vertexModel.generateContentStream({ contents });

                // 4️⃣ Itera sui chunk via streamingResp.stream
                for await (const chunk of streamingResp.stream) {
                    const delta = chunk.candidates?.[0]?.parts?.[0]?.text;
                    if (delta) {
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                }

                // 5️⃣ Chiudi correttamente
                res.write("data: [DONE]\n\n");
                return res.end();

            } catch (err) {
                console.error("Vertex AI error:", err);
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Vertex AI failed", details: err.message });
                }
                // se eravamo in SSE, invia un evento errore
                res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
                return res.end();
            }
        }
        /*else if (service === "openaiSimulateur") {
            apiKey = process.env.OPENAI_API_KEY_SIMULATEUR;
            apiUrl = "https://api.openai.com/v1/chat/completions";

            // Make the request to OpenAI in stream mode
            const response = await axiosInstance.post(apiUrl, req.body, {
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                responseType: 'stream'
            });

            // Set headers for SSE streaming
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");

            // Forward each chunk received from the OpenAI server
            response.data.on('data', (chunk) => {
                res.write(chunk);
            });

            response.data.on('end', () => {
                res.end();
            });

            response.data.on('error', (error) => {
                console.error("Error in stream:", error);
                res.end();
            });

            return; // Stop execution here to avoid sending further responses

        }*/else if (service === "openaiSimulateur") {
            // 1) Prepara la connessione SSE
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.flushHeaders(); // forza l’invio degli header

            // 2) Avvia lo streaming dalla SDK OpenAI
            const stream = await openai.chat.completions.create({
                model: req.body.model,
                messages: req.body.messages,
                stream: true
            });

            // 3) Inoltra i delta.content come SSE
            for await (const part of stream) {
                const delta = part.choices?.[0]?.delta?.content;
                if (delta) {
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
                }
            }

            // 4) Una volta finito, estrai il conteggio esatto dei token
            const totalTokens = stream.usage?.total_tokens ?? 0;
            res.write(`data: ${JSON.stringify({ usage: { total_tokens: totalTokens } })}\n\n`);

            // 5) Chiudi il flusso con il DONE
            res.write("data: [DONE]\n\n");
            return res.end();
        }
        else if (service === "openai-tts") {
            const apiKey = process.env.OPENAI_API_KEY_SIMULATEUR;

            if (!apiKey) {
                console.error("OpenAI API key missing!");
                return res.status(500).json({ error: "OpenAI API key missing" });
            }

            const { text, selectedVoice } = req.body;

            if (!text) {
                return res.status(400).json({ error: "Text is required" });
            }

            //Map language to a voice
            const allowedVoices = [
                "alloy", // female
                "echo",  // male
                "fable", // female
                "onyx",  // male
                "nova",  // female
                "shimmer" //female
            ];

            const cleanVoice = selectedVoice ? selectedVoice.trim().toLowerCase() : "";
            const voice = allowedVoices.includes(cleanVoice) ? cleanVoice : "fable";

            console.log("Using voice:", voice);

            const requestData = {
                model: "gpt-4o-mini-tts",
                input: text,
                voice: voice,
                instructions: "Speak in a gentle, slow and friendly way."
            };

            try {
                const response = await axios.post(
                    "https://api.openai.com/v1/audio/speech",
                    requestData,
                    {
                        headers: {
                            "Authorization": `Bearer ${apiKey}`,
                            "Content-Type": "application/json"
                        },
                        responseType: "arraybuffer"
                    }
                );

                console.log("Audio received from OpenAI!");
                res.setHeader("Content-Type", "audio/mpeg");
                return res.send(response.data);

            } catch (error) {
                if (error.response) {
                    console.error("OpenAI TTS error:", error.response.data);
                    return res.status(error.response.status).json({ error: error.response.data });
                } else {
                    console.error("Unknown OpenAI TTS error:", error.message);
                    return res.status(500).json({ error: "Unknown OpenAI TTS error" });
                }
            }
        } else if (service === "streaming-openai-tts") {
            const { text, selectedVoice } = req.body;
            if (!text) return res.status(400).json({ error: "Text is required" });

            const allowedVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
            const voice = allowedVoices.includes((selectedVoice || "").trim().toLowerCase())
                ? selectedVoice.trim().toLowerCase()
                : "fable";

            try {
                // 1. chiama la SDK – niente Axios
                const ttsResp = await openai.audio.speech.create({
                    model: "tts-1", //"tts-1-hd" "gpt-4o-mini-tts"
                    input: text,
                    voice,
                    instructions: "Speak in a cheerful and positive tone.",
                    response_format: "mp3"          // oppure "wav"
                });

                // 2. inoltra lo stream al client
                res.setHeader("Content-Type", "audio/mpeg");
                res.setHeader("Transfer-Encoding", "chunked");
                ttsResp.body.pipe(res);            // <‑‑‑ DONE

            } catch (err) {
                console.error("OpenAI TTS error:", err);
                return res.status(500).json({ error: "OpenAI TTS failed" });
            }
        }
        else if (service === "azureTextToSpeech") {
            const { text, selectedVoice } = req.body;
            if (!text) {
                return res.status(400).json({ error: "Text is required" });
            }

            // 1️⃣ Parametre de .env
            const endpoint = process.env.AZURE_TTS_ENDPOINT;
            const apiKey = process.env.AZURE_TTS_KEY;
            const deployment = "tts";                          // model name
            const apiVersion = "2025-03-01-preview";

            // 2️⃣ URL 
            const url = `${endpoint}/openai/deployments/${deployment}/audio/speech?api-version=${apiVersion}`;

            // 3️⃣ Mappa friendly → Azure voice (aggiungi le tue se serve)
            const voiceMap = {
                alloy: "alloy",
                echo: "echo",
                fable: "fable",
                onyx: "onyx",
                nova: "nova",
                shimmer: "shimmer"
            };
            const key = (selectedVoice || "").trim().toLowerCase();
            const voice = voiceMap[key] || "fable";

            // 4️⃣ Corpo JSON
            const body = {
                model: "tts-1",
                input: text,
                voice
            };

            try {
                const response = await axios.post(
                    url,
                    body,
                    {
                        headers: {
                            "Content-Type": "application/json",
                            "api-key": apiKey,
                            "Accept": "audio/mpeg"
                        },
                        responseType: "arraybuffer"
                    }
                );

                // 5️⃣ Rispondi con il blob audio
                res.setHeader("Content-Type", "audio/mpeg");
                return res.send(response.data);

            } catch (err) {
                console.error("Azure TTS error:", err.response?.data || err.message);
                return res.status(err.response?.status || 500)
                    .json({ error: "Azure TTS failed", details: err.message });
            }
        }
        else if (service === "elevenlabs") {
            apiKey = process.env.ELEVENLAB_API_KEY;

            if (!apiKey) {
                console.error("ElevenLabs API key missing!");
                return res.status(500).json({ error: "ElevenLabs API key missing" });
            }

            const { text, selectedLanguage } = req.body; // The frontend must pass this data
            console.log("Language received from frontend:", selectedLanguage);

            // Let's move `voiceMap` above `voiceId`
            const voiceMap = {
                "espagnol": "l1zE9xgNpUTaQCZzpNJa",
                "français": "1a3lMdKLUcfcMtvN772u",
                "anglais": "7tRwuZTD1EWi6nydVerp"
            };

            const cleanLanguage = selectedLanguage ? selectedLanguage.trim().toLowerCase() : "";
            console.log("Clean language:", cleanLanguage);

            const voiceId = voiceMap[cleanLanguage];

            if (!voiceId) {
                console.error(`Not supported language: ${cleanLanguage}`);
                return res.status(400).json({ error: "Not supported language" });
            }

            console.log(`Selected Voice ID: ${voiceId}`);

            apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

            const requestData = {
                text: text,
                model_id: "eleven_flash_v2_5",
                voice_settings: {
                    stability: 0.6,
                    similarity_boost: 0.7,
                    style: 0.1
                }
            };

            console.log("Data sent to ElevenLabs:", requestData);

            try {
                const response = await axios.post(apiUrl, requestData, {
                    headers: {
                        "xi-api-key": apiKey,
                        "Content-Type": "application/json"
                    },
                    responseType: "arraybuffer" // To return the audio as a file
                });

                console.log("Audio received from ElevenLabs!");
                res.setHeader("Content-Type", "audio/mpeg");
                return res.send(response.data);

            } catch (error) {
                if (error.response) {
                    try {
                        const errorMessage = error.response.data.toString(); // Decode the buffer into text
                        console.error("❌ Error with ElevenLabs:", errorMessage);
                        res.status(error.response.status).json({ error: errorMessage });
                    } catch (decodeError) {
                        console.error("❌ Error with ElevenLabs (not decodable):", error.response.data);
                        res.status(error.response.status).json({ error: "Unknown error with ElevenLabs" });
                    }
                } else {
                    console.error("Unknown error with ElevenLabs:", error.message);
                    res.status(500).json({ error: "Unknown error with ElevenLabs" });
                }
            }
        } else if (service === "assistantOpenaiAnalyseStreaming") {
            const assistantId = process.env.OPENAI_ASSISTANTID;

            try {

                let thread;
                const incomingId = req.body.threadId;

                if (incomingId) {
                    // thread già esistente: basta l’oggetto con id
                    thread = { id: incomingId };

                    // aggiungi i nuovi messaggi al thread
                    for (const msg of req.body.messages) {
                        await openai.beta.threads.messages.create(thread.id, msg);
                    }
                } else {
                    // nessun ID ricevuto: crea thread usa‑e‑getta con i messaggi iniziali
                    thread = await openai.beta.threads.create({ messages: req.body.messages });
                }

                /* 2️⃣  lancio la run IN STREAM */
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.flushHeaders();

                /* 3️⃣  SE È UN NUOVO THREAD, INVIA SUBITO L’ID AL CLIENT ---------- */
                if (!incomingId) {
                    res.write(`data: ${JSON.stringify({ threadId: thread.id })}\n\n`);
                }

                const stream = await openai.beta.threads.runs.createAndStream(
                    thread.id,
                    { assistant_id: assistantId, stream: true }   // stream:true è fondamentale
                );

                /* 3️⃣  inoltro i delta al browser */
                for await (const event of stream) {
                    const delta = event.data?.delta?.content;
                    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                }

                /* 4️⃣  chiudo lo SSE */
                res.write("data: [DONE]\n\n");
                return res.end();

            } catch (err) {
                console.error("assistantOpenaiAnalyseStreaming:", err);
                // se la connessione SSE è già partita, chiudi con un evento errore
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Assistant error", details: err.message });
                }
                res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
        }
        else if (service === "assistantOpenaiAnalyse") {
            assistantId = process.env.OPENAI_ASSISTANTID;
            try {
                // 1️⃣ crea un thread usa‑e‑getta
                const thread = await openai.beta.threads.create({
                    messages: req.body.messages
                });

                // 2️⃣ lancia il run NON‑stream
                const run = await openai.beta.threads.runs.create(
                    thread.id,
                    {
                        assistant_id: assistantId
                    }
                );

                // 3️⃣ poll ogni secondo finché non è finito
                let runStatus;
                do {
                    await new Promise(r => setTimeout(r, 1000));
                    runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
                } while (runStatus.status !== "completed" && runStatus.status !== "failed");

                if (runStatus.status !== "completed") {
                    return res.status(500).json({ error: "Assistant run failed", details: runStatus.status });
                }

                // 4️⃣ recupera l’ultima risposta del thread
                const msgs = await openai.beta.threads.messages.list(thread.id, { limit: 1, order: "desc" });
                const answer = msgs.data[0]?.content?.[0]?.text?.value ?? "";

                return res.json({ answer });
            } catch (err) {
                console.error("assistantOpenaiAnalyse:", err);
                return res.status(500).json({ error: "Assistant error", details: err.message });
            }
        }
        else if (service === "openaiAnalyse") {
            // 1️⃣ Prepara headers SSE
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.flushHeaders(); // forza l’invio immediato degli header

            try {
                // 2️⃣ Avvia lo stream con OpenAI
                const stream = await openai.chat.completions.create({
                    model: req.body.model,
                    messages: req.body.messages,
                    stream: true
                });

                // 3️⃣ Inoltra i delta al browser in tempo reale
                for await (const part of stream) {
                    const delta = part.choices?.[0]?.delta?.content;
                    if (delta) {
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                }

                // 4️⃣ Chiudi correttamente il flusso
                res.write("data: [DONE]\n\n");
                res.end();

            } catch (error) {
                console.error("❌ Errore nello stream openaiAnalyse:", error.message);
                res.write(`data: ${JSON.stringify({ error: "Errore durante lo streaming AI." })}\n\n`);
                res.end();
            }
        }
        /* else if (service === "openaiAnalyse") {
            apiKey = process.env.OPENAI_API_KEY_ANALYSE;
            apiUrl = "https://api.openai.com/v1/chat/completions";

            const response = await axiosInstance.post(apiUrl, req.body, {
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                }
            });

            return res.json(response.data);
        }*/else if (service === "azureOpenaiAnalyse") {
            const apiKey = process.env.AZURE_OPENAI_KEY_SIMULATEUR;
            const endpoint = process.env.AZURE_OPENAI_ENDPOINT_SIMULATEUR;
            const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_COACH;
            const apiVersion = process.env.AZURE_OPENAI_API_VERSION_COACH;

            const apiUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

            console.log("➡️ Azure Analyse URL:", apiUrl);
            console.log("➡️ Request body:", JSON.stringify(req.body, null, 2));

            try {
                const response = await axiosInstance.post(apiUrl, req.body, {
                    headers: {
                        "api-key": apiKey,
                        "Content-Type": "application/json"
                    }
                });
                return res.json(response.data);
            } catch (error) {
                console.error("❌ Azure Analyse Error:");
                if (error.response) {
                    console.error("Status:", error.response.status);
                    console.error("Data:", JSON.stringify(error.response.data, null, 2));
                    return res.status(error.response.status).json(error.response.data);
                } else {
                    console.error("Message:", error.message);
                    return res.status(500).json({ error: "Errore interno Azure Analyse" });
                }
            }
        }
        else {
            return res.status(400).json({ error: "Invalid service" });
        }
    } catch (error) {
        // Timeout error handling for OpenAI Analyse
        if (error.code === 'ECONNABORTED' && service === "openaiAnalyse") {
            console.error("OpenAI Analyse API request timeout.");
            return res.status(504).json({ error: "Timeout in the request to OpenAI Analyse." });
        }

        console.error(`API error ${req.params.service}:`, error.response?.data || error.message);
        res.status(500).json({ error: "API request error" });
    }
});

// Secure endpoint to obtain a temporary Azure Speech token.
app.get("/get-azure-token", async (req, res) => {
    const apiKey = process.env.AZURE_SPEECH_API_KEY;
    const region = process.env.AZURE_REGION;

    if (!apiKey || !region) {
        return res.status(500).json({ error: "Azure keys missing in the backend" });
    }

    try {
        const tokenRes = await axios.post(
            `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
            null,
            {
                headers: {
                    "Ocp-Apim-Subscription-Key": apiKey
                }
            }
        );

        // We send the token and the region to the frontend.
        res.json({
            token: tokenRes.data,
            region
        });
    } catch (error) {
        console.error("Failed to generate Azure token:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

// Avvia il server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});