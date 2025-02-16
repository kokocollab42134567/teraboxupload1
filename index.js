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

// Use memory storage (No local storage)
const upload = multer({ storage: multer.memoryStorage() });

// WebSocket Server for live updates
const wss = new Server({ noServer: true });

// Global Puppeteer variables
let browser;
let page;

// ** Initialize Puppeteer (Only Once) **
async function initPuppeteer() {
    if (browser) return;

    browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Load saved cookies if available
    if (fs.existsSync(COOKIES_PATH)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        await page.setCookie(...cookies);
        console.log("✅ Loaded session cookies.");
    }

    await page.goto('https://www.terabox.com/main?category=all', { waitUntil: 'networkidle2' });
    console.log("✅ Logged into TeraBox.");

    // Save cookies after login
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

// ** Upload File to TeraBox from Memory **
async function uploadToTeraBox(fileBuffer, fileName, ws) {
    try {
        if (!browser || !page) {
            console.log("⚠️ Browser not initialized, starting now...");
            await initPuppeteer();
        }

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 10, status: "Starting Upload..." }));

        await page.evaluate(() => document.body.click());

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 30, status: "Uploading File..." }));

        // Convert file buffer to a base64 string
        const base64File = fileBuffer.toString('base64');
        const fileInputSelector = 'input#h5Input0';

        await page.waitForSelector(fileInputSelector, { visible: true });

        await page.evaluate(async (selector, fileBase64, fileName) => {
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

        await new Promise(r => setTimeout(r, 5000));

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 60, status: "Processing File..." }));

        // Select the first file row (assumed uploaded file)
        const firstRowSelector = 'tbody tr:first-child';
        await page.waitForSelector(firstRowSelector, { visible: true });
        await page.click(firstRowSelector);

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 80, status: "Generating Link..." }));

        // Click the Share button
        const shareButtonSelector = '[title="Share"]';
        await page.waitForSelector(shareButtonSelector, { visible: true });
        await page.click(shareButtonSelector);

        // Click the copy link button
        const copyButtonSelector = '.private-share-btn';
        await page.waitForSelector(copyButtonSelector, { visible: true });
        await page.click(copyButtonSelector);

        // Extract share link
        const linkSelector = '.copy-link-content p.text';
        const shareLink = await page.$eval(linkSelector, el => el.textContent.trim());

        console.log(`🔗 Share Link: ${shareLink}`);

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 100, status: "Upload Complete!", link: shareLink }));

        return { success: true, link: shareLink };

    } catch (error) {
        console.error("❌ Upload error:", error);
        return { success: false, error: error.message };
    }
}

// ** API Endpoint for Uploads **
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    console.log(`📥 Received file: ${req.file.originalname}`);

    const ws = req.ws;
    const result = await uploadToTeraBox(req.file.buffer, req.file.originalname, ws);
    
    res.json(result);
});

// ** Start Server **
const server = app.listen(port, async () => {
    await initPuppeteer();
    console.log(`🚀 Server running at http://localhost:${port}`);
});

// ** WebSocket Upgrade Handling **
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (message) => console.log("💬 WebSocket message:", message));
    });
});
