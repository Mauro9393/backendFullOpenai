// Include jsPDF from a CDN
var script = document.createElement('script');
script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"; // Latest stable version
script.onload = function () {
    // Initialize the array to maintain the chat history
    var chatHistoryLog = [];

    // Function to update the chat history
    function updateChatHistory() {
        // Get the current content of chatHistory
        var fullChatHistory = player.GetVar("chatHistory"); // Replace with your Storyline variable
        let chatHistory = fullChatHistory.replace(/^Moi[^\n]*(?:\r?\n)?/, "");
        // Add the new content to the chatHistoryLog array
        chatHistoryLog.push(chatHistory);
    }

    // Function to create and download the PDF
    function generatePDFchat() {
        const { jsPDF } = window.jspdf; // Ensure that jsPDF is available

        // Get the value of the Storyline variable "user"
        var userName = "Historique de votre conversation"; // Replace with your Storyline variable for the username

        // Create a new PDF document
        var doc = new jsPDF();

        // Set the desired font (e.g., Helvetica)
        doc.setFont("Helvetica");
        doc.setFontSize(18);


        // Set the initial coordinates
        var x = 20;
        var y = 20;
        var lineHeight = 9;
        var pageHeight = doc.internal.pageSize.height; // Page height in points
        var pageWidth = doc.internal.pageSize.width; // Page width in points
        var bottomMargin = 10; // Bottom margin

        function addLogo(doc) {
            var imgWidth = 50;
            var imgHeight = 50;
            var imgX = (doc.internal.pageSize.width - imgWidth) / 2; // Centered logo
            var imgY = 10; // Vertical position

            var logoBase64 = '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'; // Sostituisci con il tuo Base64

            doc.addImage(logoBase64, "PNG", imgX, imgY, imgWidth, imgHeight);
        }

        // Function to draw the background on every page
        function drawBackground(doc, isFirstPage) {
            if (!isFirstPage) return;
            var pageWidth = doc.internal.pageSize.width;
            var pageHeight = doc.internal.pageSize.height;

            // Gradient from blue to white
            var steps = 120;
            var startColor = { r: 180, g: 200, b: 255 };

            for (var i = 0; i < steps; i++) {
                var fadeFactor = i / steps * 4; // Progressive value from 0 to 1
                if (fadeFactor > 1) fadeFactor = 1;
                var colorR = Math.floor(startColor.r + (255 - startColor.r) * fadeFactor);
                var colorG = Math.floor(startColor.g + (255 - startColor.g) * fadeFactor);
                var colorB = Math.floor(startColor.b + (255 - startColor.b) * fadeFactor);

                doc.setFillColor(colorR, colorG, colorB); // Fade to white
                doc.rect(0, (pageHeight / steps) * i, pageWidth - 0, pageHeight / steps, 'F');
            }
        }

        drawBackground(doc, true);
        addLogo(doc);
        y += 60;

        // Print the username centered at the top
        var textWidth = doc.getTextWidth(userName);
        var userX = (pageWidth - textWidth) / 2; // Calculate the position to center the text
        doc.setTextColor(29, 0, 96);
        doc.text(userName, userX, y); // Print the username centered
        y += lineHeight * 2; // Add space below the username

        doc.setFontSize(12);

        // Set a maximum width for the text
        var maxWidth = 160; // For example, PDF width - margins

        // Concatenate all the content from the chat history
        var fullChatHistory = chatHistoryLog.join("\n"); // Separate each block with a space between the lines

        // Break the text into lines that respect the maximum page width
        var lines = doc.splitTextToSize(fullChatHistory, maxWidth);

        // Loop through to write each line, going to the next line if necessary and adding pages when the text exceeds the page height
        lines.forEach(function (line) {
            if (line.startsWith("Moi") || line.startsWith("Christophe")) {
                // add line
                y += lineHeight;

                // new page if text done at the end of the page
                if (y + lineHeight > pageHeight - bottomMargin) {
                    doc.addPage();
                    drawBackground(doc, false);
                    y = 20; // Reset vertical position
                }

                // Split text "Moi " "Christophe "
                var spaceIndex = line.indexOf(" ");
                var speaker = line.substring(0, spaceIndex); // "Moi",  "Christophe"
                var message = line.substring(spaceIndex + 1); // rest of line text

                // Print in bold
                doc.setFont("Helvetica", "bold");
                doc.text(speaker, x, y);

                var speakerWidth = doc.getTextWidth(speaker + " ");

                // Print normal text after bold
                doc.setFont("Helvetica", "normal");
                doc.text(message, x + speakerWidth, y);

                y += lineHeight; // Go to the next line
            } else {
                if (y + lineHeight > pageHeight - bottomMargin) {
                    doc.addPage();
                    drawBackground(doc, false);
                    y = 20;
                }
                doc.text(line, x, y);
                y += lineHeight;
            }
        });
        // Save the PDF with a specific name
        doc.save('Historique de votre conversation.pdf');
    }
    // Update the chat history
    updateChatHistory();
    // Generate PDF
    generatePDFchat();
};
document.head.appendChild(script);