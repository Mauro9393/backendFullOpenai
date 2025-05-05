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

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_SIMULATEUR
});

// Timeout for OpenAI on Vercel waiting for the response from OpenAI
const API_TIMEOUT = 320000; // 5 min

// Configure axios with a timeout for OpenAI
const axiosInstance = axios.create({
    timeout: API_TIMEOUT // Set the maximum timeout for all requests to OpenAI
});

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
                model: "tts-1",
                input: text,
                voice: voice
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
        } else if (service === "elevenlabs") {
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
        } else if (service === "assistantOpenaiAnalyse") {
            // 1️⃣ Prepara headers SSE
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.flushHeaders();

            try {
                // 2️⃣ Avvia lo streaming verso il tuo Assistant specifico
                const stream = await openai.assistants.chat.completions.create({
                    assistant: "asst_z4vVC0dOyHqX7KLApHlLf6gX",
                    // puoi passare un user ID facoltativo
                    user: req.body.user || "anonymous",
                    messages: req.body.messages,
                    stream: true
                });

                // 3️⃣ Inoltra i delta.content come SSE
                for await (const part of stream) {
                    const delta = part.choices?.[0]?.delta?.content;
                    if (delta) {
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                }

                // 4️⃣ Chiudi il flusso
                res.write("data: [DONE]\n\n");
                res.end();

            } catch (error) {
                console.error("❌ Errore nello stream assistantOpenaiAnalyse:", error);
                res.write(`data: ${JSON.stringify({ error: "Errore durante lo streaming dal tuo Assistant." })}\n\n`);
                res.end();
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
        } else if (service === "openaiAnalyse") {
            const apiKey = process.env.AZURE_OPENAI_KEY_SIMULATEUR;
            const endpoint = process.env.AZURE_OPENAI_ENDPOINT_SIMULATEUR;
            const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_SIMULATEUR;
            const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

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
        }*/
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