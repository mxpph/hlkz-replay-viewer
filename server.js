require('dotenv').config();

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const axios = require('axios');
const cors = require('cors');
const { HttpStatusCode } = axios
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises')
const { glob } = require('glob')
const logger = require('loglevel');

logger.setLevel(process.env.LOGLEVEL || 'info');

const app = express();

const PORT = process.env.PORT || 3000;
const REPLAY_SERVER_URL = process.env.REPLAY_SERVER_URL;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!REPLAY_SERVER_URL) {
    logger.error('REPLAY_SERVER_URL not set in .env');
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
        logger.warn(`Request blocked from unauthorized origin: ${requestOrigin}`);
        return res.status(HttpStatusCode.Forbidden).json({ error: "Forbidden: Origin not allowed." });
    }
    next(); // Proceed if the origin matches
};

// Max 15 download requests every 5 minute per IP
const downloadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 15,
    message: "Too many downloads, please try again after 5 minutes"
});

app.use(cors(corsOptions))
app.use(express.static('public'));
app.use('/resources', express.static('resources', {
    etag: true,
    immutable: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
}));
app.use('/downloads', express.static('downloads'));
app.use('/api/prepare-run', downloadLimiter);
app.disable('x-powered-by');

async function downloadReplayFile(url, outputPath) {
    logger.info(`Downloading replay from: ${url}`);
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    await pipeline(response.data, writer);
}

async function downloadMapFiles(mapName) {
    logger.info(`Downloading resources for map ${mapName}`);
    const outputPrefix = path.join(__dirname, 'downloads', mapName);
    const url = `https://hlkz.sourceruns.org/api/download/${mapName}`;
    const writer = fs.createWriteStream(outputPrefix);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    await pipeline(response.data, writer);
    // TODO: more robust to inspect header bytes of file rather than rely on Content-Disposition
    if (response.headers['content-disposition'].indexOf(".bsp") > -1) {
        fs.renameSync(outputPrefix, path.join(__dirname, 'resources', 'maps', `${mapName}.bsp`))
    } else {
        logger.info(`Extracting ${mapName} ZIP file to /resources`);
        const zip = new AdmZip(outputPrefix);
        zip.extractAllTo(path.join(__dirname, 'resources'), true);
        fs.unlinkSync(outputPrefix);
        fs.rmSync(path.join(__dirname, 'resources', 'maps', `${mapName}.res`), { force: true });
        fs.rmSync(path.join(__dirname, 'resources', 'sound'), { recursive: true, force: true });
        fs.rmSync(path.join(__dirname, 'resources', 'sounds'), { recursive: true, force: true });
        fs.rmSync(path.join(__dirname, 'resources', 'models'), { recursive: true, force: true });
    }
}

async function deleteMatchingFiles(pattern) {
    logger.info(`Deleting files matching: ${pattern}`);
    const files = await glob(pattern, { nodir: true });
    logger.debug(`Matching files: ${files}`);
    await Promise.all(files.map(file => fs.promises.unlink(file)));
}

app.get('/api/prepare-run', checkOrigin, async (req, res) => {
    const { id, mapName, uniqueId } = req.query;

    if (!id || !mapName || !uniqueId) {
        logger.info(`Malformed request for id="${id}", mapName="${mapName}", uniqueId="${uniqueId}"`);
        return res.status(HttpStatusCode.BadRequest).send("Missing id or mapName or uniqueId");
    }

    const idRegex = /^\d+$/
    if (!idRegex.test(id)) {
        logger.info(`Malformed id in request for id="${id}", mapName="${mapName}", uniqueId="${uniqueId}"`);
        return res.status(HttpStatusCode.BadRequest).send("Invalid id format");
    }
    const mapNameRegex = /^[a-zA-Z0-9_\-\[\]]+$/;
    if (!mapNameRegex.test(mapName)) {
        logger.info(`Malformed mapName in request for id="${id}", mapName="${mapName}", uniqueId="${uniqueId}"`);
        return res.status(HttpStatusCode.BadRequest).send("Invalid mapName format");
    }
    const steamIdRegex = /^STEAM_[0-5]:[0-1]:\d+$/;
    if (!steamIdRegex.test(uniqueId)) {
        logger.info(`Malformed uniqueId in request for id="${id}", mapName="${mapName}", uniqueId="${uniqueId}"`);
        return res.status(HttpStatusCode.BadRequest).send("Invalid uniqueId format");
    }

    try {
        logger.info(`Request for: id="${id}", mapName="${mapName}", uniqueId="${uniqueId}`);
        const sid = uniqueId.split(':');
        sid[0] = sid[0].split('_')[1]
        const replayPrefix = `${mapName}_${sid[0]}_${sid[1]}_${sid[2]}_pure`
        const replayLocalFilename = `${replayPrefix}_${id}.dat`;
        const replayUrl = `${REPLAY_SERVER_URL}/${replayPrefix}.dat`;
        const localReplayPath = path.join(__dirname, 'resources', 'replays', replayLocalFilename);
        if (!fs.existsSync(localReplayPath)) {
            const replayPrefixPath = path.join(__dirname, 'resources', 'replays', glob.escape(replayPrefix));
            await deleteMatchingFiles(`${replayPrefixPath}_*\\.dat`);
            await downloadReplayFile(replayUrl, localReplayPath);
        } else {
            logger.debug(`Replay file already found, skipping download.`);
        }

        const mapResourceDir = path.join(__dirname, 'resources', 'maps', `${mapName}.bsp`);
        if (!fs.existsSync(mapResourceDir)) {
            await downloadMapFiles(mapName);
        } else {
            logger.info(`Map file(s) already found, skipping download.`);
        }

        res.json({
            success: true,
            replayFilename: replayLocalFilename,
            mapName,
        });

    } catch (error) {
        logger.error(error)
        res.status(HttpStatusCode.InternalServerError).json({ success: false, error: "Failed to download run. Please try again later." });
    }
});

app.use((err, req, res, next) => {
    logger.error(error);
    res.status(HttpStatusCode.InternalServerError).send("Something broke!");
});

app.listen(PORT, () => {
    logger.info(`Server running at http://localhost:${PORT}`);
});
