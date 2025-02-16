const puppeteer = require('puppeteer');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const COOKIES_PATH = path.resolve(__dirname, 'terabox_cookies.json');

// Enable CORS
app.use(cors());

// Use memory storage (No local file storage)
const upload = multer({ storage: multer.memoryStorage() });

async function uploadToTeraBox(fileBuffer, fileName) {
    const MAX_RETRIES = 3;
    let attempt = 0;
    let requestId = Date.now(); // Unique ID for tracking each file upload

    while (attempt < MAX_RETRIES) {
        let browser;
        let uploadPage;

        try {
            console.log(`🔄 Attempt ${attempt + 1}/${MAX_RETRIES} for file: ${fileName} (Request ID: ${requestId})`);

            // Launch a new isolated browser instance
            browser = await puppeteer.launch({
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Use installed Chrome
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-features=site-per-process',
                    '--disable-web-security'
                ]
            });

            uploadPage = await browser.newPage();
            await uploadPage.setViewport({ width: 1280, height: 800 });
            await uploadPage.setUserAgent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
            );

            // Load cookies if available
            if (fs.existsSync(COOKIES_PATH)) {
                const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
                await uploadPage.setCookie(...cookies);
            }

            console.log("🌍 Navigating to TeraBox...");
            await uploadPage.goto('https://www.terabox.com/main?category=all', { waitUntil: 'load', timeout: 60000 });

            console.log("✅ Page loaded successfully.");

            const fileInputSelector = 'input#h5Input0';
            await uploadPage.waitForSelector(fileInputSelector, { visible: true, timeout: 20000 });

            // **Store the initial first row ID**
            const firstRowSelector = 'tbody tr:first-child';
            let initialRowId = await uploadPage.evaluate((selector) => {
                const row = document.querySelector(selector);
                return row ? row.getAttribute('data-id') : null;
            }, firstRowSelector);

            console.log("📌 Stored initial first row ID:", initialRowId);

            console.log(`📤 Uploading file: ${fileName} (Request ID: ${requestId})`);

            // Convert buffer to base64
            const base64File = fileBuffer.toString('base64');

            // Simulate file upload
            await uploadPage.evaluate((selector, fileBase64, fileName) => {
                const input = document.querySelector(selector);
                const data = atob(fileBase64);
                const array = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    array[i] = data.charCodeAt(i);
                }
                const file = new File([array], fileName, { type: "application/octet-stream" });
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, fileInputSelector, base64File, fileName);

            console.log(`📤 File uploaded: ${fileName}`);

            // **Wait for upload to complete by detecting new row ID**
            console.log("⏳ Waiting for the upload to complete...");
            await uploadPage.waitForFunction(
                (selector, initialId) => {
                    const row = document.querySelector(selector);
                    return row && row.getAttribute('data-id') !== initialId;
                },
                { timeout: 600000 }, // Wait up to 10 minutes
                firstRowSelector,
                initialRowId
            );

            console.log("✅ Upload finished, new file detected.");

            // **Store the ID of the new uploaded file's row**
            let uploadedRowId = await uploadPage.evaluate((selector) => {
                const row = document.querySelector(selector);
                return row ? row.getAttribute('data-id') : null;
            }, firstRowSelector);

            console.log("📌 Stored uploaded row ID:", uploadedRowId);

            // **Select the first row and its checkbox**
            await uploadPage.waitForSelector(firstRowSelector, { visible: true });
            await uploadPage.click(firstRowSelector);
            console.log("✅ Selected first row");

            const checkboxSelector = 'tbody tr:first-child .wp-s-pan-table__body-row--checkbox-block.is-select';
            await uploadPage.waitForSelector(checkboxSelector, { visible: true });
            await uploadPage.click(checkboxSelector);
            console.log("✅ Selected checkbox");

            // **Share file and get the link**
            console.log("🔗 Generating share link...");
            const shareButtonSelector = '[title="Share"]';
            await uploadPage.waitForSelector(shareButtonSelector, { visible: true });
            await uploadPage.click(shareButtonSelector);

            const copyButtonSelector = '.private-share-btn';
            await uploadPage.waitForSelector(copyButtonSelector, { visible: true });
            await uploadPage.click(copyButtonSelector);

            const linkSelector = '.copy-link-content p.text';
            await uploadPage.waitForSelector(linkSelector, { visible: true });
            const shareLink = await uploadPage.$eval(linkSelector, el => el.textContent.trim());

            console.log(`✅ Share Link: ${shareLink}`);

            // 🆕 **Step: Click on the row that matches the stored uploaded row ID**
            if (uploadedRowId) {
                const uploadedCheckboxSelector = `tbody tr[data-id="${uploadedRowId}"] .wp-s-pan-table__body-row--checkbox-block.is-select`;
                await uploadPage.waitForSelector(uploadedCheckboxSelector, { visible: true });
                await uploadPage.click(uploadedCheckboxSelector);
                console.log(`✅ Clicked on the uploaded row (ID: ${uploadedRowId})`);
            } else {
                console.log("⚠️ Could not find uploaded row ID. Skipping row click.");
            }

            await uploadPage.close();
            await browser.close();
            console.log("❎ Closed the browser.");

            return { success: true, link: shareLink };
        } catch (error) {
            console.error(`❌ Upload error on attempt ${attempt + 1}:`, error);
            attempt++;

            if (uploadPage) await uploadPage.close();
            if (browser) await browser.close();
        }
    }

    return { success: false, error: "Upload failed after multiple attempts." };
}

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    console.log(`📥 Received file: ${req.file.originalname}`);
    const result = await uploadToTeraBox(req.file.buffer, req.file.originalname);
    res.json(result);
});

const server = app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});
