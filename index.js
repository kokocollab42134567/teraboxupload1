const puppeteer = require('puppeteer');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { Server } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const COOKIES_PATH = path.resolve(__dirname, 'terabox_cookies.json');

// Enable CORS
app.use(cors());

// Use memory storage (No local file storage)
const upload = multer({ storage: multer.memoryStorage() });

// WebSocket Server for real-time updates
const wss = new Server({ noServer: true });

// Global Puppeteer variables
let browser;
let page;

async function initPuppeteer() {
    if (browser) return;

    console.log("🚀 Launching Puppeteer...");
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

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    // Load cookies if available
    if (fs.existsSync(COOKIES_PATH)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        await page.setCookie(...cookies);
        console.log("✅ Loaded session cookies.");
    }

    console.log("🌍 Navigating to TeraBox...");
    await page.goto('https://www.terabox.com/main?category=all', {
        waitUntil: 'load',
        timeout: 10000
    }).catch(err => console.log("⚠️ Initial load failed, retrying..."));

    console.log("✅ Page loaded successfully.");
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log("🛠 Logged into TeraBox.");

    // Save cookies after login
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

async function uploadToTeraBox(fileBuffer, fileName) {
    let uploadPage;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        try {
            console.log(`🔄 Attempt ${retryCount + 1} to upload: ${fileName}`);

            if (!browser || browser.isClosed()) {
                console.log("⚠️ Browser is closed, restarting...");
                await initPuppeteer();
            }

            uploadPage = await browser.newPage();
            await uploadPage.setViewport({ width: 1280, height: 800 });

            if (fs.existsSync(COOKIES_PATH)) {
                const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
                await uploadPage.setCookie(...cookies);
            }

            console.log("🌍 Navigating to TeraBox...");
            await uploadPage.goto('https://www.terabox.com/main?category=all', { waitUntil: 'load', timeout: 15000 });

            console.log("✅ Page loaded successfully.");

            // Ensure the file input is available
            const fileInputSelector = 'input#h5Input0';
            await uploadPage.waitForSelector(fileInputSelector, { visible: true, timeout: 30000 });

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

            console.log(`📤 Uploaded file: ${fileName}`);

            // Store initial row ID before upload
            const firstRowSelector = 'tbody tr:first-child';
            let initialRowId = await uploadPage.evaluate((selector) => {
                const row = document.querySelector(selector);
                return row ? row.getAttribute('data-id') : null;
            }, firstRowSelector);

            console.log("📌 Stored initial row ID:", initialRowId);

            // Wait for upload completion
            console.log("⏳ Waiting for the upload to complete...");
            await uploadPage.waitForFunction(
                (selector, initialId) => {
                    const row = document.querySelector(selector);
                    return row && row.getAttribute('data-id') !== initialId;
                },
                { timeout: 600000, polling: 1000 }, // Check every second
                firstRowSelector,
                initialRowId
            );

            console.log("✅ Upload finished, new file detected.");

            // Select the first row
            await uploadPage.waitForSelector(firstRowSelector, { visible: true });
            await uploadPage.click(firstRowSelector);
            console.log("✅ Selected first row");

            // Select checkbox
            const checkboxSelector = 'tbody tr:first-child .wp-s-pan-table__body-row--checkbox-block.is-select';
            await uploadPage.waitForSelector(checkboxSelector, { visible: true });
            await uploadPage.click(checkboxSelector);
            console.log("✅ Selected checkbox");

            // Click Share button
            const shareButtonSelector = '[title="Share"]';
            await uploadPage.waitForSelector(shareButtonSelector, { visible: true });
            await uploadPage.click(shareButtonSelector);
            console.log("✅ Clicked Share button");

            // Copy the share link
            const copyButtonSelector = '.private-share-btn';
            await uploadPage.waitForSelector(copyButtonSelector, { visible: true, timeout: 30000 });
            await uploadPage.click(copyButtonSelector);
            console.log("✅ Clicked Copy Link button");

            // Get the share link
            const linkSelector = '.copy-link-content p.text';
            await uploadPage.waitForSelector(linkSelector, { visible: true, timeout: 30000 });
            const shareLink = await uploadPage.$eval(linkSelector, el => el.textContent.trim());
            console.log(`🔗 Share Link: ${shareLink}`);

            await uploadPage.close();
            return { success: true, link: shareLink };

        } catch (error) {
            console.log(`❌ Upload attempt ${retryCount + 1} failed: ${error.message}`);
            retryCount++;
            if (uploadPage) await uploadPage.close();

            if (retryCount < maxRetries) {
                console.log("🔄 Retrying upload after reloading...");
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.log("🚫 Maximum retries reached. Upload failed.");
                return { success: false, error: "Upload failed after multiple attempts." };
            }
        }
    }
}





app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    console.log(`📥 Received file: ${req.file.originalname}`);
    const ws = req.ws;
    const result = await uploadToTeraBox(req.file.buffer, req.file.originalname, ws);
    res.json(result);
});

const server = app.listen(port, async () => {
    await initPuppeteer();
    console.log(`🚀 Server running at http://localhost:${port}`);
});

server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (message) => console.log("💬 WebSocket message:", message));
    });
});
