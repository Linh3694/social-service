# @wis/observability (nhúng trong service)

Bản cục bộ thư mục `observability-node/` trong repo microservice — thay đổi chỉ có hiệu tại service đó.

Tham chiếu stack monitoring: repo `observability/`.

```javascript
const { initObservability } = require('@wis/observability');
const app = express();
initObservability({ serviceName: 'my-service', expressApp: app });
```

- Env: **`OTEL_EXPORTER_OTLP_ENDPOINT`**, **`LOG_LEVEL`**
- Endpoint: **GET `/metrics`**

