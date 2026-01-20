require('dotenv').config();

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const axios = require('axios');
const cors = require('cors');
const { HttpStatusCode } = axios
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const util = require('util');
const { glob } = require('glob')

const app = express();
const pipeline = util.promisify(stream.pipeline);

const PORT = process.env.PORT || 3000;
const REPLAY_SERVER_URL = process.env.REPLAY_SERVER_URL;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!REPLAY_SERVER_URL) {
    console.error("Fatal error: REPLAY_SERVER_URL not set in .env");
    process.exit(1);
}

const corsOptions = {
    origin: CORS_ORIGIN,
    optionsSuccessStatus: HttpStatusCode.Ok
};

const checkOrigin = (req, res, next) => {
    const allowedOrigin = process.env.CORS_ORIGIN;
    const requestOrigin = req.headers.origin || req.headers.referer;
    if (requestOrigin && !requestOrigin.startsWith(allowedOrigin)) {
        console.log(`[BLOCKED] Request from unauthorized origin: ${requestOrigin}`);
        return res.status(HttpStatusCode.Forbidden).json({ error: "Forbidden: Origin not allowed." });
    }
    next(); // Proceed if the origin matches
};

// Max 15 download requests every 5 minute per IP
const downloadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 15,
    message: "Too many downloads, please try again after 5 minutes"
});

app.use(cors(corsOptions))
app.use(express.static('public'));
app.use('/resources', express.static('resources'));
app.use('/downloads', express.static('downloads'));
app.use('/api/prepare-run', downloadLimiter);
app.disable('x-powered-by');

async function downloadFile(url, outputPath) {
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    await pipeline(response.data, writer);
}

async function deleteMatchingFiles(pattern) {
    console.log(`[INFO] Deleting files matching: ${pattern}`);
    const files = await glob(pattern, { nodir: true });
    await Promise.all(files.map(file => fs.unlink(file)));
}

app.get('/api/prepare-run', checkOrigin, async (req, res) => {
    const { id, mapName, uniqueId } = req.query;

    if (!id || !mapName || !uniqueId) {
        return res.status(HttpStatusCode.BadRequest).send("Missing id or mapName or uniqueId");
    }

    const idRegex = /^\d+$/
    if (!idRegex.test(id)) {
        return res.status(HttpStatusCode.BadRequest).send("Invalid id format");
    }
    const mapNameRegex = /^[a-zA-Z0-9_\-\[\]]+$/;
    if (!mapNameRegex.test(mapName)) {
        return res.status(HttpStatusCode.BadRequest).send("Invalid mapName format");
    }
    const steamIdRegex = /^STEAM_[0-5]:[0-1]:\d+$/;
    if (!steamIdRegex.test(uniqueId)) {
        return res.status(HttpStatusCode.BadRequest).send("Invalid uniqueId format");
    }

    try {
        console.log(`[INFO] Request for: Map=${mapName}, ID=${uniqueId}`);
        const sid = uniqueId.split(':');
        if (sid.length !== 3) {
            throw new Error("Invalid SteamID format");
        }
        sid[0] = sid[0].split('_')[1]
        const replayPrefix = `${mapName}_${sid[0]}_${sid[1]}_${sid[2]}_pure`
        const replayLocalFilename = `${replayPrefix}_${id}.dat`;
        const replayUrl = `${REPLAY_SERVER_URL}/${replayPrefix}.dat`;
        const localReplayPath = path.join(__dirname, 'resources', 'replays', replayLocalFilename);
        if (!fs.existsSync(localReplayPath)) {
            await deleteMatchingFiles(RegExp.escape(`${replayPrefix}_*.dat`));
            console.log(`[DL] Downloading replay from: ${replayUrl}`);
            await downloadFile(replayUrl, localReplayPath);
        } else {
            console.log(`[CACHE] Map and replay file found: ${replayPrefix}.dat`);
        }

        const mapResourceDir = path.join(__dirname, 'resources', 'maps', `${mapName}.bsp`);
        if (!fs.existsSync(mapResourceDir)) {
            console.log(`[DL] Map resources missing. Fetching ${mapName}.zip...`);
            const zipUrl = `https://hlkz.sourceruns.org/api/download/${mapName}`;
            const zipPath = path.join(__dirname, 'downloads', `${mapName}.zip`);
            await downloadFile(zipUrl, zipPath);
            console.log(`[ZIP] Extracting...`);
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(path.join(__dirname, 'resources'), true);
            fs.unlinkSync(zipPath);
        }

        res.json({
            success: true,
            replayFilename: replayLocalFilename,
            mapName,
        });

    } catch (error) {
        console.error("[ERROR]", error.message);
        res.status(HttpStatusCode.InternalServerError).json({ success: false, error: error.message });
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(HttpStatusCode.InternalServerError).send("Something broke!");
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});