const axios = require('axios');
require('dotenv').config({ path: './config.env' });

class FrappeService {
  constructor() {
    this.baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
    this.apiKey = process.env.FRAPPE_API_KEY;
    this.apiSecret = process.env.FRAPPE_API_SECRET;
    // Bật đồng bộ Frappe mặc định nếu không cấu hình (tránh break auth ở môi trường chưa khai báo biến)
    this.enabled = (process.env.ENABLE_FRAPPE_SYNC || 'true') === 'true';

    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    // Chỉ thêm API Key/Secret khi request chưa có Authorization sẵn (ví dụ Bearer từ mobile)
    this.api.interceptors.request.use((config) => {
      const headers = config.headers || {};
      const hasAuthorizationHeader = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'authorization'
      );
      if (this.apiKey && this.apiSecret && !hasAuthorizationHeader) {
        headers['Authorization'] = `token ${this.apiKey}:${this.apiSecret}`;
      }
      config.headers = headers;
      return config;
    });
  }

  async authenticateUser(token) {
    if (!this.enabled) throw new Error('Frappe sync is disabled');

    const commonHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // 1) Thử endpoint ERP tuỳ biến (ưu tiên vì app mobile đang dùng)
    const url = '/api/method/erp.api.erp_common_user.auth.get_current_user';
    try {
      try {
        console.log('[FrappeService] → GET', `${this.baseURL}${url}`, {
          authHeader: 'Bearer <hidden>',
          tokenLen: typeof token === 'string' ? token.length : 0,
        });
      } catch {}

      const erpResp = await this.api.get(url, { headers: commonHeaders });
      try {
        console.log('[FrappeService] ← ERP status:', erpResp.status);
        const preview = typeof erpResp.data === 'string'
          ? erpResp.data.slice(0, 800)
          : JSON.stringify(erpResp.data).slice(0, 800);
        console.log('[FrappeService] ← ERP body preview:', preview);
      } catch {}

      const raw = erpResp.data;
      const data = raw && (raw.message || raw);
      
      // Check various response structures from Frappe
      if (data) {
        // Structure 1: { success: true, data: { user: {...} } }
        if (data.success === true && data.data && data.data.user) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 1)');
          return data.data.user;
        }
        // Structure 2: { status: 'success', user: {...} }
        if (data.status === 'success' && data.user) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 2)');
          return data.user;
        }
        // Structure 3: { user: {...}, authenticated: true }
        if (data.user && data.authenticated === true) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 3)');
          return data.user;
        }
        // Structure 4: Just { user: {...} } without explicit authenticated flag
        if (data.user && data.authenticated !== false) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 4 - implicit)');
          return data.user;
        }
      }
      
      try { console.warn('[FrappeService] ERP responded but not authenticated, data:', JSON.stringify(data).substring(0, 200)); } catch {}
    } catch (e) {
      try {
        const status = e?.response?.status;
        const respData = e?.response?.data;
        const preview = typeof respData === 'string'
          ? respData.slice(0, 800)
          : JSON.stringify(respData || {}).slice(0, 800);
        console.error('[FrappeService] ERP request failed', {
          status,
          body: preview,
          message: e?.message,
        });
      } catch {}
      // Tiếp tục fallback dưới
    }

    // 2) Fallback: dùng phương thức chuẩn của Frappe
    // 2) Nếu Bearer không được map session, coi như không xác thực
    throw new Error('Frappe did not accept Bearer token');
  }
}

module.exports = new FrappeService();

