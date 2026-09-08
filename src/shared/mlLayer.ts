import featureStore from './featureStore';
import logger from './logger';
import db from './db';
import { FeatureVector, featureVectorToArray } from './featureEngineering';

export type MLPrediction = 'LONG' | 'SHORT' | 'NO_EDGE';

export interface MLEdgeEstimate {
  prediction: MLPrediction;
  probability: number;
  confidence: number; // calibrated probability distance from neutral
  rawScore: number;
}

interface LogisticModel {
  weights: number[];
  bias: number;
  featureMean: number[];
  featureStd: number[];
  accuracy: number;
  trainedAt: number;
}

/**
 * Tiny in-memory logistic-regression ML layer.
 * No external ML dependency — pure TypeScript.
 */
export class MLPredictor {
  private longModel?: LogisticModel;
  private shortModel?: LogisticModel;

  /**
   * Train two binary classifiers (long vs not, short vs not) on stored feature history.
   */
  async train(symbol: string, minSamples = 50): Promise<void> {
    const labeled = await featureStore.loadLabeled(symbol);
    if (labeled.length < minSamples) {
      logger.warn('MLPredictor: insufficient labeled samples to train', {
        symbol,
        samples: labeled.length,
      });
      return;
    }

    const X = labeled.map((r) => r.features);
    const yLong = labeled.map((r) => (r.label === 1 ? 1 : 0));
    const yShort = labeled.map((r) => (r.label === -1 ? 1 : 0));

    this.longModel = this.fitLogistic(X, yLong);
    this.shortModel = this.fitLogistic(X, yShort);

    await this.persistModel(symbol, 'long', this.longModel);
    await this.persistModel(symbol, 'short', this.shortModel);

    logger.info('MLPredictor trained', {
      symbol,
      samples: labeled.length,
      longAccuracy: Number(this.longModel.accuracy.toFixed(4)),
      shortAccuracy: Number(this.shortModel.accuracy.toFixed(4)),
    });
  }

  predict(features: FeatureVector): MLEdgeEstimate {
    const x = featureVectorToArray(features);
    const xNorm = this.normalize(x, this.longModel?.featureMean, this.longModel?.featureStd);

    const longProb = this.sigmoid(this.dot(this.longModel?.weights ?? [], xNorm) + (this.longModel?.bias ?? 0));
    const shortProb = this.sigmoid(this.dot(this.shortModel?.weights ?? [], xNorm) + (this.shortModel?.bias ?? 0));

    if (longProb > 0.6 && longProb > shortProb) {
      return {
        prediction: 'LONG',
        probability: longProb,
        confidence: Math.abs(longProb - 0.5) * 2,
        rawScore: longProb - shortProb,
      };
    }
    if (shortProb > 0.6 && shortProb > longProb) {
      return {
        prediction: 'SHORT',
        probability: shortProb,
        confidence: Math.abs(shortProb - 0.5) * 2,
        rawScore: shortProb - longProb,
      };
    }
    return {
      prediction: 'NO_EDGE',
      probability: Math.max(1 - longProb - shortProb, 0),
      confidence: 1 - Math.max(longProb, shortProb),
      rawScore: longProb - shortProb,
    };
  }

  /**
   * Train if enough data exists, then return a prediction for the current feature vector.
   */
  async trainAndPredict(symbol: string, features: FeatureVector): Promise<MLEdgeEstimate> {
    const recent = await featureStore.loadRecent(symbol, 200);
    if (recent.length >= 100) {
      await this.train(symbol, 50);
    }
    return this.predict(features);
  }

  private fitLogistic(X: number[][], y: number[]): LogisticModel {
    const n = X.length;
    const dims = X[0].length;
    const { mean, std } = this.computeStats(X);
    const XNorm = X.map((row) => this.normalize(row, mean, std));

    let weights = new Array(dims).fill(0);
    let bias = 0;
    const lr = 0.05;
    const epochs = 200;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let dw = new Array(dims).fill(0);
      let db = 0;
      for (let i = 0; i < n; i++) {
        const z = this.dot(weights, XNorm[i]) + bias;
        const p = this.sigmoid(z);
        const error = p - y[i];
        for (let j = 0; j < dims; j++) {
          dw[j] += error * XNorm[i][j];
        }
        db += error;
      }
      for (let j = 0; j < dims; j++) {
        weights[j] -= (lr / n) * dw[j];
      }
      bias -= (lr / n) * db;
    }

    let correct = 0;
    for (let i = 0; i < n; i++) {
      const z = this.dot(weights, XNorm[i]) + bias;
      const p = this.sigmoid(z);
      const pred = p >= 0.5 ? 1 : 0;
      if (pred === y[i]) correct++;
    }

    return {
      weights,
      bias,
      featureMean: mean,
      featureStd: std,
      accuracy: correct / n,
      trainedAt: Date.now(),
    };
  }

  private computeStats(X: number[][]): { mean: number[]; std: number[] } {
    const dims = X[0].length;
    const mean = new Array(dims).fill(0);
    for (const row of X) {
      for (let j = 0; j < dims; j++) mean[j] += row[j];
    }
    for (let j = 0; j < dims; j++) mean[j] /= X.length;

    const std = new Array(dims).fill(0);
    for (const row of X) {
      for (let j = 0; j < dims; j++) std[j] += Math.pow(row[j] - mean[j], 2);
    }
    for (let j = 0; j < dims; j++) std[j] = Math.sqrt(std[j] / X.length) || 1e-9;

    return { mean, std };
  }

  private normalize(row: number[], mean?: number[], std?: number[]): number[] {
    if (!mean || !std) return row;
    return row.map((v, i) => (v - mean[i]) / std[i]);
  }

  private dot(a: number[], b: number[]): number {
    return a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-z));
  }

  private async persistModel(symbol: string, label: string, model: LogisticModel): Promise<void> {
    await db.query(
      `INSERT INTO ml_models (symbol, label, weights, bias, feature_mean, feature_std, accuracy, trained_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (symbol, label) DO UPDATE SET
         weights = EXCLUDED.weights,
         bias = EXCLUDED.bias,
         feature_mean = EXCLUDED.feature_mean,
         feature_std = EXCLUDED.feature_std,
         accuracy = EXCLUDED.accuracy,
         trained_at = EXCLUDED.trained_at`,
      [
        symbol,
        label,
        JSON.stringify(model.weights),
        model.bias,
        JSON.stringify(model.featureMean),
        JSON.stringify(model.featureStd),
        model.accuracy,
      ]
    );
  }
}

export const mlPredictor = new MLPredictor();
export default mlPredictor;
