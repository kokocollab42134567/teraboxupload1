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

// Multer - Memory Storage (No Local Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// WebSocket Server for Progress Updates
const wss = new Server({ noServer: true });

// Global Puppeteer variables
let browser;
let page;

async function initPuppeteer() {
    // If running in Render, set a custom executable path for Puppeteer
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || puppeteer.executablePath();

    browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920x1080'
        ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Load cookies if available
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


// 🟢 Upload File to TeraBox
async function uploadToTeraBox(fileBuffer, fileName, ws) {
    try {
        if (!browser || !page) {
            console.log("⚠️ Browser not initialized, initializing now...");
            await initPuppeteer();
        }

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 10, status: "Starting Upload..." }));

        await page.reload({ waitUntil: 'networkidle2' });

        // Close any popups
        await page.evaluate(() => document.body.click());

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 30, status: "Uploading File..." }));

        // Temporary save buffer to file (needed for Puppeteer)
        const tempFilePath = `/tmp/${fileName}`;
        fs.writeFileSync(tempFilePath, fileBuffer);

        // File Upload Input
        const fileInputSelector = 'input#h5Input0';
        await page.waitForSelector(fileInputSelector, { visible: true });

        const inputUploadHandle = await page.$(fileInputSelector);
        await inputUploadHandle.uploadFile(tempFilePath);
        console.log(`📤 Uploaded file: ${fileName}`);

        // Wait for upload to complete
        await new Promise(r => setTimeout(r, 5000));

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 60, status: "Processing File..." }));

        // Select first uploaded file
        const firstRowSelector = 'tbody tr:first-child';
        await page.waitForSelector(firstRowSelector, { visible: true });
        await page.click(firstRowSelector);

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 80, status: "Generating Link..." }));

        // Click "Share" button
        const shareButtonSelector = '[title="Share"]';
        await page.waitForSelector(shareButtonSelector, { visible: true });
        await page.click(shareButtonSelector);

        // Click "Copy Link"
        const copyButtonSelector = '.private-share-btn';
        await page.waitForSelector(copyButtonSelector, { visible: true });
        await page.click(copyButtonSelector);

        // Extract the link
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

// 🟢 API Endpoint to Handle File Uploads
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    console.log(`📥 Received file: ${req.file.originalname}`);

    const ws = req.ws;
    const result = await uploadToTeraBox(req.file.buffer, req.file.originalname, ws);

    res.json(result);
});

// 🟢 Start Server
const server = app.listen(port, async () => {
    await initPuppeteer(); // Start Puppeteer when the server starts
    console.log(`🚀 Server running at http://localhost:${port}`);
});

// 🟢 Handle WebSocket Upgrade
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (message) => console.log("💬 WebSocket message:", message));
    });
});
