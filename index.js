const puppeteer = require('puppeteer');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SELF_CHECK_URL = "https://teraboxupload1-production.up.railway.app/hi";

async function checkServerHealth() {
    try {
        const response = await axios.get(SELF_CHECK_URL);
        console.log(`🔄 Self-check response: ${response.data}`);
    } catch (error) {
        console.error("❌ Self-check failed:", error.message);
    }
}

// Run the health check every 10 seconds
setInterval(checkServerHealth, 10000);

const app = express();
const port = process.env.PORT || 3000;
const COOKIES_PATH = path.resolve(__dirname, 'terabox_cookies.json');
app.use((req, res, next) => {
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Allow CORS for debugging
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
});
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Enable CORS
app.use(cors());
app.get('/hi', (req, res) => {
    console.log("✅ /hi endpoint was accessed.");
    res.send("hi");
});

// Use memory storage (No local file storage)
const upload = multer({
    storage: multer.diskStorage({
        destination: '/tmp/',  // ✅ Use Railway's temporary storage
        filename: (req, file, cb) => {
            cb(null, Date.now() + '-' + file.originalname);
        }
    }),
    limits: { fileSize: 500 * 1024 * 1024 } // Increase limit if needed
});



async function uploadToTeraBox(filePath, fileName) {
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
                protocolTimeout: 120000,  // <-- Increase Puppeteer protocol timeout
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Use installed Chrome
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-features=site-per-process',
                    '--disable-web-security',
                    '--disable-http2',  // Disable HTTP/2
                    '--proxy-server="direct://"',
                    '--proxy-bypass-list=*'
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

            

            const inputUploadHandle = await uploadPage.$(fileInputSelector);
            await inputUploadHandle.uploadFile(filePath);
            console.log(`📤 File selected for upload: ${filePath}`);

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
            fs.unlinkSync(filePath); 
            console.log(`🗑️ Deleted temporary file: ${filePath}`);

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

    try {
        const result = await uploadToTeraBox(req.file.path, req.file.originalname);

        if (!result.success) {
            console.error("❌ Upload failed:", result.error);
            return res.status(500).json({ success: false, message: result.error || "Upload failed." });
        }

        console.log("✅ Upload successful, sending JSON response...");
        res.json(result);  // <-- Ensure this is sent properly
    } catch (error) {
        console.error("❌ Server error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});


const server = app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});
server.timeout = 600000; // 10 minutes
server.headersTimeout = 650000; // Increase header timeout

