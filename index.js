const puppeteer = require('puppeteer');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { Server } = require('ws');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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
// /hi endpoint to keep the server alive
app.get('/hi', (req, res) => {
    res.send('hi');
});

// Self-ping every 5 seconds
setInterval(async () => {
    try {
        await axios.get('https://teraboxupload1.onrender.com/hi');
    } catch (error) {
        console.error('❌ Self-ping failed:', error.message);
    }
}, 5000);
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
    }

    console.log("🌍 Navigating to TeraBox...");
    await page.goto('https://www.terabox.com/main?category=all', {
        waitUntil: 'load',
        timeout: 50000
    }).catch(err => console.log("⚠️ Initial load failed, retrying..."));
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Save cookies after login
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

async function uploadToTeraBox(fileBuffer, fileName) {
    try {
        if (!browser) await initPuppeteer();

        // Open a new tab for each upload request
        const uploadPage = await browser.newPage();
        await uploadPage.setViewport({ width: 1280, height: 800 });
        await uploadPage.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
        );

        // Load session cookies
        if (fs.existsSync(COOKIES_PATH)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
            await uploadPage.setCookie(...cookies);
        }

        await uploadPage.goto('https://www.terabox.com/main?category=all', { waitUntil: 'load', timeout: 50000 });


        const fileInputSelector = 'input#h5Input0';
        await uploadPage.waitForSelector(fileInputSelector, { visible: true });

        // Convert file buffer to base64 and simulate file input
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

        console.log(`📤 Uploaded file: ${fileName}`);

        // Store the initial row ID
        const firstRowSelector = 'tbody tr:first-child';
        let initialRowId = await uploadPage.evaluate((selector) => {
            const row = document.querySelector(selector);
            return row ? row.getAttribute('data-id') : null;
        }, firstRowSelector);

        await uploadPage.waitForFunction(
            (selector, initialId) => {
                const row = document.querySelector(selector);
                return row && row.getAttribute('data-id') !== initialId;
            },
            { timeout: 600000 },
            firstRowSelector,
            initialRowId
        );


        // Select the first row and checkbox
        await uploadPage.waitForSelector(firstRowSelector, { visible: true });
        await uploadPage.click(firstRowSelector);

        const checkboxSelector = 'tbody tr:first-child .wp-s-pan-table__body-row--checkbox-block.is-select';
        await uploadPage.waitForSelector(checkboxSelector, { visible: true });
        await uploadPage.click(checkboxSelector);

        // Click the Share button
        const shareButtonSelector = '[title="Share"]';
        await uploadPage.waitForSelector(shareButtonSelector, { visible: true });
        await uploadPage.click(shareButtonSelector);

        // Wait for the Copy Link button
        const copyButtonSelector = '.private-share-btn';
        await uploadPage.waitForSelector(copyButtonSelector, { visible: true, timeout: 30000 });
        await uploadPage.click(copyButtonSelector);

        // Get the share link
        const linkSelector = '.copy-link-content p.text';
        await uploadPage.waitForSelector(linkSelector, { visible: true, timeout: 30000 });
        const shareLink = await uploadPage.$eval(linkSelector, el => el.textContent.trim());

        // Close the tab after upload
        await uploadPage.close();

        return { success: true, link: shareLink };
    } catch (error) {
        console.error("❌ Upload error:", error);
        return { success: false, error: error.message };
    }
}




app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

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
