"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("./shared/db"));
const logger_1 = __importDefault(require("./shared/logger"));
const redisBus_1 = __importDefault(require("./shared/redisBus"));
const orchestrator_1 = __importDefault(require("./agents/orchestrator"));
async function main() {
    await redisBus_1.default.connect();
    await db_1.default.query('SELECT 1');
    const log = await orchestrator_1.default.runOnce();
    console.log(JSON.stringify(log, (key, value) => {
        if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Decimal') {
            return value.toString();
        }
        if (value instanceof Date)
            return value.toISOString();
        return value;
    }, 2));
    await redisBus_1.default.disconnect();
    await db_1.default.close();
}
main().catch((err) => {
    logger_1.default.error('Run-cycle failed', { err });
    process.exit(1);
});
//# sourceMappingURL=run-cycle.js.map