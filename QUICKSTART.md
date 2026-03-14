# Quick Start Guide - Windows

## One-Time Setup (First Time Only)

### 1. Install Node.js
- Download from: https://nodejs.org/ (Choose LTS version)
- Run the installer and follow the steps
- Verify installation by opening Command Prompt and typing: `node --version`

### 2. Install Oracle Instant Client (Required!)
- Download from: https://www.oracle.com/database/technologies/instant-client/downloads.html
- Select your Windows version (64-bit recommended)
- Download "Basic" or "Basic Light" package
- Extract to a folder like: `C:\oracle\instantclient`
- Add to system PATH:
  1. Press `Win + X` and select "System"
  2. Click "Advanced system settings"
  3. Click "Environment Variables"
  4. Under "System variables", find "Path" and click "Edit"
  5. Click "New" and add your Instant Client path
  6. Click OK and restart Command Prompt

### 3. Navigate to Project Folder
```
cd C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater
```

### 4. Install Dependencies (First Time Only)
```
npm install
```

## Running the Application (Every Time)

### Option 1: Command Prompt
```
cd C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater
npm start
```

### Option 2: PowerShell
```
cd C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater
npm start
```

### Expected Output:
```
Oracle Connection Pool Created Successfully
Server is running on http://localhost:3000
```

## Access the App
Open your browser and go to: **http://localhost:3000**

## Stop the App
Press `Ctrl + C` in the Command Prompt/PowerShell

---

**That's it! Your web app is ready to use.**

For detailed documentation, see README.md
