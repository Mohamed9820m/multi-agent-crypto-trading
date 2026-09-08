"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../shared/db"));
const logger_1 = __importDefault(require("../shared/logger"));
const redisBus_1 = __importDefault(require("../shared/redisBus"));
const guardian_1 = __importDefault(require("../agents/guardian"));
async function main() {
    await redisBus_1.default.connect();
    await db_1.default.query('SELECT 1');
    logger_1.default.info('Guardian runner started');
    const gracefulShutdown = async (signal) => {
        logger_1.default.info(`Guardian received ${signal}, exiting`);
        await redisBus_1.default.disconnect();
        await db_1.default.close();
        process.exit(0);
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    await guardian_1.default.runLoop();
}
main().catch(async (err) => {
    logger_1.default.error('Guardian fatal error', { err });
    await redisBus_1.default.disconnect().catch(() => undefined);
    await db_1.default.close().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=run-guardian.js.map