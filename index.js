const puppeteer = require('puppeteer');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('ws');

const app = express();
const port = 3000;

const COOKIES_PATH = path.resolve(__dirname, 'terabox_cookies.json');
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');

app.use(cors()); // Enable CORS for all origins

// Ensure the upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

// WebSocket Server for Real-Time Progress Updates
const wss = new Server({ noServer: true });

// Global browser instance to keep session alive
let browser;
let page;

// Initialize Puppeteer and login once
async function initPuppeteer() {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    if (fs.existsSync(COOKIES_PATH)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        await page.setCookie(...cookies);
        console.log("Loaded session cookies.");
    }

    await page.goto('https://www.terabox.com/main?category=all', { waitUntil: 'networkidle2' });
    console.log("Logged in to TeraBox.");

    // Save cookies after login
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

// Function to handle file upload to TeraBox
async function uploadToTeraBox(filePath, ws) {
    try {
        if (!browser || !page) {
            console.log("Browser not initialized, initializing now...");
            await initPuppeteer();
        }

        // Notify frontend (Start upload)
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 10, status: "Starting Upload..." }));

        await page.reload({ waitUntil: 'networkidle2' });

        // Click body to close ads/popups
        await page.evaluate(() => document.body.click());
        console.log("Clicked on body to close ads.");

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 30, status: "Uploading File..." }));

        // Wait for file upload input
        const fileInputSelector = 'input#h5Input0';
        await page.waitForSelector(fileInputSelector, { visible: true });

        // Upload the file
        const inputUploadHandle = await page.$(fileInputSelector);
        await inputUploadHandle.uploadFile(filePath);
        console.log(`Uploaded file: ${filePath}`);

        // Wait for upload to complete
        await new Promise(r => setTimeout(r, 5000));

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 60, status: "Processing File..." }));

        // Select first uploaded file
        const firstRowSelector = 'tbody tr:first-child';
        await page.waitForSelector(firstRowSelector, { visible: true });
        await page.click(firstRowSelector);
        console.log("Clicked first row.");

        // Click the file checkbox
        const checkboxSelector = 'tbody tr:first-child td.wp-s-pan-table__body-row--checkbox-block.is-select';
        await page.waitForSelector(checkboxSelector, { visible: true });
        await page.click(checkboxSelector);
        console.log("Selected the uploaded file.");

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 80, status: "Generating Link..." }));

        // Click "Share" button
        const shareButtonSelector = '[title="Share"]';
        await page.waitForSelector(shareButtonSelector, { visible: true });
        await page.click(shareButtonSelector);
        console.log('Clicked "Share" button.');

        // Click "Copy Link" button
        const copyButtonSelector = '.private-share-btn';
        await page.waitForSelector(copyButtonSelector, { visible: true });
        await page.click(copyButtonSelector);
        console.log('Clicked "Copy Link" button.');

        // Wait for the success message
        const successMessageSelector = 'div.u-message.u-message--success';
        await page.waitForSelector(successMessageSelector, { visible: true });
        console.log("Upload success confirmed.");

        // Extract the share link
        const linkSelector = '.copy-link-content p.text';
        const shareLink = await page.$eval(linkSelector, el => el.textContent.trim());

        console.log(`Extracted link: ${shareLink}`);

        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ progress: 100, status: "Upload Complete!", link: shareLink }));

        return { success: true, link: shareLink };

    } catch (error) {
        console.error("Upload error:", error);
        return { success: false, error: error.message };
    }
}

// Express API route to handle file uploads with progress tracking
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    console.log(`Received file: ${req.file.path}`);
    
    // Store WebSocket client connection
    const ws = req.ws;

    // Start upload
    const result = await uploadToTeraBox(req.file.path, ws);
    
    res.json(result);
});

// Handle WebSocket Upgrade
const server = app.listen(port, async () => {
    await initPuppeteer(); // Initialize Puppeteer on startup
    console.log(`Server running at http://localhost:${port}`);
});

// Attach WebSocket server
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (message) => console.log("WebSocket message:", message));
    });
});
