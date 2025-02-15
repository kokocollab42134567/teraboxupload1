# Step 1: Start with a base image
FROM node:16-slim

# Step 2: Install dependencies needed for Puppeteer and Chromium
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fontconfig \
    libx11-dev \
    libxcomposite-dev \
    libxrandr-dev \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libnspr4 \
    libnss3 \
    libxss1 \
    libasound2 \
    libappindicator3-1 \
    libxtst6 \
    libgbm1 \
    libgtk-3-0 \
    libpango1.0-0 \
    libgdk-pixbuf2.0-0 \
    libxinerama1 \
    libgdk-pixbuf2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Install Chromium
RUN apt-get update && apt-get install -y chromium

# Step 4: Set the environment variable for Chromium executable
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium

# Step 5: Set the working directory inside the container
WORKDIR /app

# Step 6: Copy package.json and install dependencies
COPY package.json /app
RUN npm install

# Step 7: Copy the rest of the application files
COPY . /app

# Step 8: Expose the port that your app will run on
EXPOSE 3000

# Step 9: Start the app
CMD ["node", "index.js"]
