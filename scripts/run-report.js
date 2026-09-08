"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../shared/db"));
const logger_1 = __importDefault(require("../shared/logger"));
const redisBus_1 = __importDefault(require("../shared/redisBus"));
const reporting_1 = __importDefault(require("../agents/reporting"));
async function main() {
    await redisBus_1.default.connect();
    await db_1.default.query('SELECT 1');
    const report = await reporting_1.default.generateDailyReport();
    console.log(report);
    await redisBus_1.default.disconnect();
    await db_1.default.close();
}
main().catch((err) => {
    logger_1.default.error('Reporting failed', { err });
    process.exit(1);
});
//# sourceMappingURL=run-report.js.map