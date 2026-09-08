import winston from 'winston';
import config from './config';

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'multi-agent-crypto' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...rest }) => {
          const meta = Object.keys(rest).length ? JSON.stringify(rest) : '';
          return `${timestamp} [${level}]: ${message} ${meta}`;
        })
      ),
    }),
  ],
});

export default logger;
