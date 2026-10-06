#!/usr/bin/env node
import { loadEnv } from '../src/config/env.js';
import { startStudioServer } from '../src/server/http-server.js';
import { setLogLevel } from '../src/utils/logger.js';

const env = loadEnv();
setLogLevel(env.STUDIO_LOG_LEVEL);
startStudioServer();
