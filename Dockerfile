# Use a lightweight Node.js image
FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# Install dependencies required for Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Puppeteer (Chrome included)
RUN npm install puppeteer

# Copy package.json first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy project files
COPY . .

# Expose the app port
EXPOSE 3000

# Run Puppeteer without sandbox issues
CMD ["node", "index.js"]
