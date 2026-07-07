'use strict';

/**
 * @wis/observability — middleware Prometheus + log pino cho microservice Express.
 */

const pino = require('pino');
const promClient = require('prom-client');

/**
 * Chuẩn hóa path để nhãn metric không quá cardinality
 */
function normalizePath(p) {
	if (!p) return '/';
	return String(p).replace(/\?.*$/u, '').replace(/\/[\da-f\-]{36}/giu, '/{uuid}').replace(/\/\d+/gu, '/{num}').slice(0, 120);
}

/**
 * OTLP traces (tuỳ chọn).
 */
function _tryStartOtlp(serviceName) {
	const ep = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '')
		.trim()
		.replace(/^https?:\/\//u, '')
		.replace(/^grpc:\/\//u, '');
	if (!ep) return;
	try {
		// eslint-disable-next-line global-require
		const { NodeSDK } = require('@opentelemetry/sdk-node');
		// eslint-disable-next-line global-require
		const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
		// eslint-disable-next-line global-require
		const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

		const sdk = new NodeSDK({
			serviceName,
			traceExporter: new OTLPTraceExporter({ url: ep }),
			instrumentations: [
				getNodeAutoInstrumentations({
					'@opentelemetry/instrumentation-fs': { enabled: false },
				}),
			],
		});
		sdk.start();
	} catch (e) {
		console.warn('[@wis/observability] OTEL không khởi động:', e && e.message);
	}
}

/**
 * Gắn middleware + endpoint GET /metrics.
 */
function initObservability(opts) {
	const serviceName = opts.serviceName || 'nodejs-service';
	const expressApp = opts.expressApp;
	const register = new promClient.Registry();

	promClient.collectDefaultMetrics({
		register,
		prefix: `${String(serviceName).replace(/-/gu, '_')}_`,
	});

	const httpDur = new promClient.Histogram({
		name: 'http_request_duration_seconds',
		help: 'Latency HTTP inbound',
		labelNames: ['method', 'path_group', 'status'],
		buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
		registers: [register],
	});
	const httpCnt = new promClient.Counter({
		name: 'http_requests_total',
		help: 'Số HTTP request',
		labelNames: ['method', 'path_group', 'status'],
		registers: [register],
	});

	const logger = pino({
		level: process.env.LOG_LEVEL || 'info',
		base: {
			service_name: serviceName,
			'service.namespace': 'wis',
		},
		timestamp: pino.stdTimeFunctions.isoTime,
	});

	expressApp.use((req, res, next) => {
		const start = process.hrtime.bigint();
		res.on('finish', () => {
			try {
				const secs = Number(process.hrtime.bigint() - start) / 1e9;
				const pathGroup = normalizePath(req.originalUrl || req.url || '');
				const st = String(res.statusCode);
				httpDur.observe({ method: req.method, path_group: pathGroup, status: st }, secs);
				httpCnt.inc({ method: req.method, path_group: pathGroup, status: st });
				logger.info(
					{
						method: req.method,
						path: req.originalUrl || req.url,
						status_code: res.statusCode,
						duration_sec: secs,
					},
					'http_request',
				);
			} catch {
				// Bỏ qua lỗi metric — không được làm crash response
			}
		});
		next();
	});

	expressApp.get('/metrics', async (_req, res) => {
		res.set('Content-Type', register.contentType);
		res.end(await register.metrics());
	});

	_tryStartOtlp(serviceName);

	return { logger, register };
}

module.exports = { initObservability, normalizePath };
