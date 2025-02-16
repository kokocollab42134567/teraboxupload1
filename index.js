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
    const MAX_RETRIES = 3;
    let attempt = 0;
    let requestId = Date.now(); // Unique ID for the request

    while (attempt < MAX_RETRIES) {
        try {
            console.log(`🔄 Attempt ${attempt + 1}/${MAX_RETRIES} for file: ${fileName} (Request ID: ${requestId})`);

            if (!browser || !page || page.isClosed()) {
                console.log("⚠️ Browser or page closed, restarting...");
                await initPuppeteer();
            }

            const uploadPage = await browser.newPage();
            await uploadPage.setViewport({ width: 1280, height: 800 });
            await uploadPage.setUserAgent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
            );

            if (fs.existsSync(COOKIES_PATH)) {
                const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
                await uploadPage.setCookie(...cookies);
            }

            console.log("🌍 Navigating to TeraBox...");
            await uploadPage.goto('https://www.terabox.com/main?category=all', { waitUntil: 'load', timeout: 15000 });

            console.log("✅ Page loaded successfully.");

            const fileInputSelector = 'input#h5Input0';
            await uploadPage.waitForSelector(fileInputSelector, { visible: true });

            const base64File = fileBuffer.toString('base64');
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

            console.log(`📤 Uploaded file: ${fileName} (Request ID: ${requestId})`);

            const firstRowSelector = 'tbody tr:first-child';
            let initialRowId = await uploadPage.evaluate((selector) => {
                const row = document.querySelector(selector);
                return row ? row.getAttribute('data-id') : null;
            }, firstRowSelector);

            console.log("📌 Stored initial row ID:", initialRowId);

            console.log("⏳ Waiting for the upload to complete...");
            try {
                await uploadPage.waitForFunction(
                    (selector, initialId) => {
                        const row = document.querySelector(selector);
                        return row && row.getAttribute('data-id') !== initialId;
                    },
                    { timeout: 60000, polling: 2000 },
                    firstRowSelector,
                    initialRowId
                );
            } catch (err) {
                console.log("⚠️ Upload timeout, reloading page and retrying...");
                await uploadPage.reload({ waitUntil: 'load' });
                attempt++;
                continue; // Retry the upload process
            }

            console.log("✅ Upload finished, new file detected.");

            await uploadPage.waitForSelector(firstRowSelector, { visible: true });
            await uploadPage.click(firstRowSelector);

            const checkboxSelector = 'tbody tr:first-child .wp-s-pan-table__body-row--checkbox-block.is-select';
            await uploadPage.waitForSelector(checkboxSelector, { visible: true });
            await uploadPage.click(checkboxSelector);

            const shareButtonSelector = '[title="Share"]';
            await uploadPage.waitForSelector(shareButtonSelector, { visible: true });
            await uploadPage.click(shareButtonSelector);

            const copyButtonSelector = '.private-share-btn';
            await uploadPage.waitForSelector(copyButtonSelector, { visible: true, timeout: 30000 });
            await uploadPage.click(copyButtonSelector);

            const linkSelector = '.copy-link-content p.text';
            await uploadPage.waitForSelector(linkSelector, { visible: true, timeout: 30000 });
            const shareLink = await uploadPage.$eval(linkSelector, el => el.textContent.trim());

            console.log(`🔗 Share Link: ${shareLink}`);

            await uploadPage.close();
            console.log("❎ Closed the upload tab.");

            return { success: true, link: shareLink };
        } catch (error) {
            console.error(`❌ Upload error on attempt ${attempt + 1}:`, error);
            attempt++;
        }
    }

    return { success: false, error: "Upload failed after multiple attempts." };
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
