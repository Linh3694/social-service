const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: './config.env' });

/**
 * 🔗 Frappe Service - Social Service
 * Service để tương tác với Frappe ERP API
 * Pattern tương tự ticket-service và inventory-service
 */
class FrappeService {
  constructor() {
    this.baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
    this.apiKey = process.env.FRAPPE_API_KEY;
    this.apiSecret = process.env.FRAPPE_API_SECRET;
    // Bật đồng bộ Frappe mặc định nếu không cấu hình
    this.enabled = (process.env.ENABLE_FRAPPE_SYNC || 'true') === 'true';
    this.timeout = parseInt(process.env.AUTH_TIMEOUT) || 20000;

    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    // Chỉ thêm API Key/Secret khi request chưa có Authorization sẵn
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

  /**
   * 🔐 Build auth headers cho request
   */
  buildAuthHeaders(token) {
    if (!token) return {};
    return {
      'Authorization': `Bearer ${token}`,
      'X-Frappe-CSRF-Token': token,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  buildParentPortalAuthHeaders(token) {
    return {
      ...(this.apiKey && this.apiSecret
        ? { 'Authorization': `token ${this.apiKey}:${this.apiSecret}` }
        : {}),
      ...(token ? { 'X-Parent-Portal-Token': token } : {}),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  decodeParentPortalToken(token) {
    if (!token) return null;
    try {
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded !== 'object') return null;
      if (decoded.exp && decoded.exp * 1000 < Date.now()) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  verifyParentPortalToken(token) {
    if (!token) return null;
    try {
      const secret = process.env.PARENT_PORTAL_JWT_SECRET || process.env.JWT_SECRET || 'breakpoint';
      const decoded = jwt.verify(token, secret);
      if (!decoded || typeof decoded !== 'object') return null;
      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * 🔑 Xác thực user bằng Bearer token từ mobile app
   */
  async authenticateUser(token) {
    if (!this.enabled) throw new Error('Frappe sync is disabled');

    const commonHeaders = this.buildAuthHeaders(token);

    // 1) Thử endpoint ERP tuỳ biến (ưu tiên vì app mobile đang dùng)
    const url = '/api/method/erp.api.erp_common_user.auth.get_current_user';
    try {
      console.log('[FrappeService] → GET', `${this.baseURL}${url}`);

      const erpResp = await this.api.get(url, { headers: commonHeaders });
      console.log('[FrappeService] ← ERP status:', erpResp.status);

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
      console.error('[FrappeService] ERP request failed:', e?.message);
    }

    // 2) Fallback: Nếu Bearer không được map session, coi như không xác thực
    throw new Error('Frappe did not accept Bearer token');
  }

  /**
   * 📋 Lấy chi tiết user từ Frappe theo email
   * @param {string} userEmail - User email hoặc username
   * @param {string} token - Bearer token
   */
  async getUserDetail(userEmail, token) {
    try {
      console.log(`[FrappeService] Fetching user detail: ${userEmail}`);
      
      const response = await this.api.get(`/api/resource/User/${userEmail}`, {
        headers: this.buildAuthHeaders(token)
      });

      if (!response.data?.data) {
        throw new Error('Invalid user data from Frappe');
      }

      const user = response.data.data;
      
      // Normalize roles
      const roles = Array.isArray(user.roles)
        ? user.roles.map(r => typeof r === 'string' ? r : r?.role).filter(Boolean)
        : [];

      return {
        name: user.name,
        email: user.email || user.name,
        full_name: user.full_name || user.first_name,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        roles: roles,
        enabled: user.enabled === 1 ? 1 : 0,
        disabled: user.disabled,
        docstatus: user.docstatus,
        user_image: user.user_image || '',
        department: user.department || '',
        location: user.location,
        job_title: user.job_title,
        designation: user.designation,
        phone: user.phone || '',
        mobile_no: user.mobile_no || '',
        employee_code: user.employee_code,
        microsoft_id: user.microsoft_id,
        user_type: user.user_type,
      };
    } catch (error) {
      console.error(`[FrappeService] Get user detail failed for ${userEmail}:`, error.message);
      return null;
    }
  }

  /**
   * 👥 Lấy tất cả enabled users từ Frappe
   * Sử dụng custom endpoint để lấy tất cả users trong 1 request
   * @param {string} token - Bearer token
   */
  async getAllEnabledUsers(token) {
    try {
      console.log('[FrappeService] Fetching all enabled users from Frappe...');

      // Gọi custom endpoint để lấy ALL users trong 1 request
      const response = await this.api.get(
        '/api/method/erp.api.erp_common_user.user_sync.get_all_enabled_users',
        { headers: this.buildAuthHeaders(token) }
      );

      const result = response.data.message || response.data;
      
      if (!result.success) {
        throw new Error(result.error || result.message || 'Failed to fetch users');
      }

      const users = result.data || [];
      const userTypeStats = result.user_types || {};

      console.log(`[FrappeService] ✅ Found ${users.length} enabled users`);
      console.log(`[FrappeService] 📊 User Types: System=${userTypeStats['System User'] || 0}, Website=${userTypeStats['Website User'] || 0}`);

      // Return users với format chuẩn
      return users.map(user => ({
        name: user.name,
        email: user.email || user.name,
        full_name: user.full_name,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        user_image: user.user_image,
        enabled: user.enabled,
        disabled: user.disabled,
        location: user.location,
        department: user.department,
        job_title: user.job_title,
        designation: user.designation,
        employee_code: user.employee_code,
        microsoft_id: user.microsoft_id,
        docstatus: user.docstatus,
        user_type: user.user_type,
        roles: user.roles || [],
      }));
    } catch (error) {
      console.error('[FrappeService] Error fetching enabled users:', error.message);
      if (error.response) {
        console.error('[FrappeService] Response status:', error.response.status);
      }
      return [];
    }
  }

  /**
   * 📄 Lấy danh sách users theo page (fallback khi custom endpoint không khả dụng)
   * @param {string} token - Bearer token  
   * @param {number} page - Page number (0-based)
   * @param {number} pageSize - Number of users per page
   */
  async getUsersPage(token, page = 0, pageSize = 100) {
    try {
      console.log(`[FrappeService] Fetching users page ${page}, size ${pageSize}`);

      const response = await this.api.get('/api/resource/User', {
        params: {
          fields: JSON.stringify([
            'name', 'email', 'full_name', 'first_name', 'middle_name', 'last_name',
            'user_image', 'enabled', 'disabled', 'docstatus', 'location', 'department',
            'job_title', 'designation', 'employee_code', 'microsoft_id', 'user_type'
          ]),
          filters: JSON.stringify([['User', 'enabled', '=', 1]]),
          limit_start: page * pageSize,
          limit_page_length: pageSize,
          order_by: 'name asc'
        },
        headers: this.buildAuthHeaders(token)
      });

      const users = response.data?.data || [];
      console.log(`[FrappeService] Fetched ${users.length} users from page ${page}`);
      return users;
    } catch (error) {
      console.error('[FrappeService] Get users page failed:', error.message);
      return [];
    }
  }

  /**
   * 🔍 Verify token và lấy thông tin user hiện tại
   * @param {string} token - Bearer token
   */
  async verifyTokenAndGetUser(token) {
    try {
      console.log('[FrappeService] Verifying token with Frappe...');
      
      // Bước 1: Lấy logged user
      const userResponse = await this.api.get('/api/method/frappe.auth.get_logged_user', {
        headers: this.buildAuthHeaders(token)
      });

      if (!userResponse.data?.message) {
        throw new Error('No user information in Frappe response');
      }

      const userName = userResponse.data.message;
      console.log(`[FrappeService] ✅ Token verified. User: ${userName}`);

      // Bước 2: Lấy full user details
      const userDetails = await this.getUserDetail(userName, token);
      return userDetails;
    } catch (error) {
      console.error('[FrappeService] Token verification failed:', error.message);
      throw new Error(`Frappe token verification failed: ${error.message}`);
    }
  }

  /**
   * 📝 Gọi Frappe method
   * @param {string} methodName - Method name trong format 'module.method_name'
   * @param {Object} params - Parameters
   * @param {string} token - Bearer token
   */
  async callMethod(methodName, params = {}, token) {
    try {
      console.log(`[FrappeService] Calling method: ${methodName}`);
      
      const response = await this.api.post(`/api/method/${methodName}`, params, {
        headers: this.buildAuthHeaders(token)
      });

      console.log(`[FrappeService] ✅ Method ${methodName} executed successfully`);
      return response.data?.message;
    } catch (error) {
      console.error(`[FrappeService] Call method failed (${methodName}):`, error.message);
      throw error;
    }
  }

  async getResource(doctype, name, token) {
    const endpoint = `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
    const response = await this.api.get(endpoint, {
      headers: token ? this.buildAuthHeaders(token) : undefined,
    });
    return response.data?.data || null;
  }

  async listResources(doctype, params = {}, token) {
    const response = await this.api.get(`/api/resource/${encodeURIComponent(doctype)}`, {
      params,
      headers: token ? this.buildAuthHeaders(token) : undefined,
    });
    return response.data?.data || [];
  }

  async getDoctypeFieldnames(doctype) {
    try {
      const meta = await this.getResource('DocType', doctype, null);
      return new Set((meta?.fields || []).map((field) => field.fieldname).filter(Boolean));
    } catch (error) {
      console.warn(`[FrappeService] Không đọc được DocType ${doctype}:`, error.message);
      return new Set();
    }
  }

  async callFrappeGetMethod(methodName, params = {}, token) {
    const response = await this.api.get(`/api/method/${methodName}`, {
      params,
      headers: token ? this.buildAuthHeaders(token) : undefined,
    });
    const message = response.data?.message ?? response.data;
    return message?.data ?? message;
  }

  async callFrappePostMethod(methodName, params = {}, token) {
    const response = await this.api.post(`/api/method/${methodName}`, params, {
      headers: token ? this.buildAuthHeaders(token) : undefined,
    });
    const message = response.data?.message ?? response.data;
    return message?.data ?? message;
  }

  async getClassMetadata(classId, token) {
    const cls = await this.getResource('SIS Class', classId, token);
    if (!cls) return null;

    let schoolYear = null;
    if (cls.school_year_id) {
      try {
        schoolYear = await this.getResource('SIS School Year', cls.school_year_id, token);
      } catch (error) {
        console.warn('[FrappeService] Không lấy được năm học của lớp:', error.message);
      }
    }

    return {
      classId: cls.name,
      classTitle: cls.title || cls.short_title || cls.name,
      schoolYearId: cls.school_year_id,
      schoolYearTitle: schoolYear?.title_vn || schoolYear?.title_en || cls.school_year_id,
      campusId: cls.campus_id,
      classType: cls.class_type,
    };
  }

  async getClassGuardianDirectory(classId, schoolYearId, token) {
    if (!classId) return { guardians: [], students: [] };

    const classRowsPayload = await this.callFrappeGetMethod(
      'erp.api.erp_sis.class_student.get_all_class_students_no_pagination',
      {
        class_id: classId,
        ...(schoolYearId ? { school_year_id: schoolYearId } : {}),
      },
      token
    );
    const classRows = Array.isArray(classRowsPayload)
      ? classRowsPayload
      : classRowsPayload?.data || [];

    const studentIds = Array.from(new Set(classRows.map((row) => row.student_id).filter(Boolean)));
    if (studentIds.length === 0) return { guardians: [], students: [] };

    let students = [];
    try {
      const payload = await this.callFrappePostMethod('erp.api.erp_sis.student.batch_get_students', {
        student_ids: studentIds,
      }, token);
      students = Array.isArray(payload) ? payload : payload?.data || [];
    } catch (error) {
      console.warn('[FrappeService] batch_get_students failed:', error.message);
    }

    const studentMap = new Map(students.map((student) => [student.name, student]));
    const guardianMap = new Map();
    const addGuardian = (guardian, relationship, studentId, familyCode) => {
      if (!guardian) return;
      const guardianId = guardian.guardian_id || guardian.name || relationship?.guardian;
      const email = guardian.email || guardian.user || '';
      const key = guardianId || email;
      if (!key) return;

      const portalEmail = guardian.guardian_id
        ? `${guardian.guardian_id}@parent.wellspring.edu.vn`
        : undefined;
      const existing = guardianMap.get(key) || {
        name: guardian.name || relationship?.guardian,
        guardian_id: guardian.guardian_id,
        guardian_name: guardian.guardian_name || guardian.full_name || guardian.name,
        email,
        portalEmail,
        guardian_image: guardian.guardian_image || guardian.user_image || guardian.avatar_url || '',
        phone_number: guardian.phone_number,
        students: [],
        matchKeys: [],
      };

      const student = studentMap.get(studentId) || { name: studentId };
      if (studentId && !existing.students.some((item) => item.student_id === studentId)) {
        existing.students.push({
          student_id: studentId,
          student_name: student.student_name,
          student_code: student.student_code,
          family_code: familyCode || student.family_code,
        });
      }

      existing.matchKeys = Array.from(new Set([
        existing.name,
        existing.guardian_id,
        existing.email,
        existing.portalEmail,
      ].filter(Boolean).map((value) => String(value).toLowerCase())));

      guardianMap.set(key, existing);
    };

    const addGuardiansFromStudentMethod = async () => {
      try {
        const payload = await this.callFrappePostMethod(
          'erp.api.erp_sis.family.get_guardians_by_students',
          { student_ids: studentIds },
          token
        );
        const guardians = Array.isArray(payload) ? payload : payload?.guardians || [];
        guardians.forEach((guardian) => {
          (guardian.students || []).forEach((student) => {
            addGuardian(guardian, { guardian: guardian.name }, student.student_id, student.family_code);
          });
        });
      } catch (error) {
        console.warn('[FrappeService] Không lấy được get_guardians_by_students:', error.message);
      }
    };

    const addGuardiansFromRelationships = async () => {
      try {
        const relationships = await this.listResources('CRM Family Relationship', {
          fields: JSON.stringify([
            'parent',
            'student',
            'guardian',
            'relationship_type',
            'key_person',
            'access',
            'display_order',
          ]),
          filters: JSON.stringify([['student', 'in', studentIds]]),
          limit_page_length: 1000,
        });
        const guardianIds = Array.from(new Set(
          relationships.map((relationship) => relationship.guardian).filter(Boolean)
        ));
        if (guardianIds.length === 0) return;

        const guardians = await this.listResources('CRM Guardian', {
          fields: JSON.stringify([
            'name',
            'guardian_id',
            'guardian_name',
            'email',
            'guardian_image',
            'phone_number',
          ]),
          filters: JSON.stringify([['name', 'in', guardianIds]]),
          limit_page_length: 1000,
        });
        const guardiansByName = Object.fromEntries(guardians.map((guardian) => [guardian.name, guardian]));

        relationships.forEach((relationship) => {
          const studentId = relationshipStudentId(relationship);
          if (!studentIds.includes(studentId)) return;
          addGuardian(guardiansByName[relationship.guardian], relationship, studentId, relationship.parent);
        });
      } catch (error) {
        console.warn('[FrappeService] Không lấy được CRM Family Relationship để dựng guardian directory:', error.message);
      }
    };

    const normalizeFamiliesPayload = (payload) => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload?.families)) return payload.families;
      if (payload && typeof payload === 'object') return [payload];
      return [];
    };

    const relationshipStudentId = (relationship) =>
      relationship?.student ||
      relationship?.student_id ||
      relationship?.student_details?.name ||
      relationship?.student_details?.student_id;

    const enrichFamilyDetails = async (family) => {
      if (Array.isArray(family?.relationships) && family.relationships.length > 0) return family;
      const familyCode = family?.family_code || family?.name;
      if (!familyCode) return family;
      try {
        return await this.callFrappeGetMethod('erp.api.erp_sis.family.get_family_details', {
          family_code: familyCode,
        }, token);
      } catch {
        return family;
      }
    };

    const familyCodes = Array.from(
      new Set(students.map((student) => student.family_code).filter(Boolean))
    );
    const familyPayloads = [];

    await Promise.all(familyCodes.map(async (familyCode) => {
      try {
        const family = await this.callFrappeGetMethod('erp.api.erp_sis.family.get_family_details', {
          family_code: familyCode,
        }, token);
        familyPayloads.push(family);
      } catch (error) {
        console.warn(`[FrappeService] Không lấy được family details ${familyCode}:`, error.message);
      }
    }));

    // Một số student API không trả family_code. Fallback theo student_id để vẫn có guardian directory.
    await Promise.all(studentIds.map(async (studentId) => {
      try {
        const payload = await this.callFrappeGetMethod('erp.api.erp_sis.family.get_family_data', {
          student_id: studentId,
        }, token);
        const families = await Promise.all(normalizeFamiliesPayload(payload).map(enrichFamilyDetails));
        familyPayloads.push(...families);
      } catch (error) {
        console.warn(`[FrappeService] Không lấy được family theo học sinh ${studentId}:`, error.message);
      }
    }));

    await addGuardiansFromStudentMethod();
    await addGuardiansFromRelationships();

    if (familyPayloads.length === 0) {
      try {
        const payload = await this.callFrappeGetMethod('erp.api.erp_sis.family.get_all_families', {}, token);
        const allFamilies = normalizeFamiliesPayload(payload);
        const matchedFamilies = allFamilies.filter((family) =>
          (family?.relationships || []).some((relationship) => studentIds.includes(relationshipStudentId(relationship)))
        );
        const families = await Promise.all(matchedFamilies.map(enrichFamilyDetails));
        familyPayloads.push(...families);
      } catch (error) {
        console.warn('[FrappeService] Không lấy được get_all_families để dựng guardian directory:', error.message);
      }
    }

    familyPayloads.forEach((family) => {
      const familyCode = family?.family_code || family?.name;
      const relationships = Array.isArray(family?.relationships) ? family.relationships : [];
      const guardiansByKey = Array.isArray(family?.guardians)
        ? Object.fromEntries(family.guardians.map((guardian) => [guardian.name || guardian.guardian_id || guardian.guardian_name, guardian]))
        : family?.guardians && typeof family.guardians === 'object'
          ? family.guardians
          : {};

      relationships.forEach((relationship) => {
        const studentId = relationshipStudentId(relationship);
        if (!studentIds.includes(studentId)) return;

        const guardian =
          relationship.guardian_details ||
          guardiansByKey[relationship.guardian] ||
          guardiansByKey[relationship.guardian_name] ||
          { name: relationship.guardian, guardian_name: relationship.guardian_name };
        addGuardian(guardian, relationship, studentId, familyCode);
      });
    });

    return {
      students: studentIds.map((studentId) => {
        const student = studentMap.get(studentId) || { name: studentId };
        return {
          student_id: studentId,
          student_name: student.student_name,
          student_code: student.student_code,
          family_code: student.family_code,
        };
      }),
      guardians: Array.from(guardianMap.values()),
    };
  }

  async getStudentClassScopes(studentId, token) {
    if (token) {
      try {
        const response = await this.api.post(
          '/api/method/erp.api.parent_portal.journal.get_student_class_scopes',
          { student_id: studentId },
          { headers: this.buildParentPortalAuthHeaders(token) }
        );
        const payload = response?.data?.message?.data || response?.data?.message || response?.data;
        if (Array.isArray(payload?.scopes)) {
          return payload.scopes;
        }
      } catch (error) {
        console.warn('[FrappeService] Parent portal journal scope failed:', {
          status: error?.response?.status,
          message: error.message,
          data: error?.response?.data,
        });
        if (token) {
          // Với Parent Portal, không fallback Resource API vì sẽ bỏ qua kiểm tra quan hệ guardian-student.
          // Cần deploy Frappe method get_student_class_scopes để trả đúng scope lớp.
          return [];
        }
      }
    }

    let rows = [];
    try {
      rows = await this.listResources('SIS Class Student', {
        filters: JSON.stringify([['SIS Class Student', 'student_id', '=', studentId]]),
        fields: JSON.stringify(['name', 'class_id', 'school_year_id', 'class_type']),
        limit_page_length: 1000,
        order_by: 'modified desc',
      }, null);
    } catch (error) {
      console.warn('[FrappeService] Không lấy được lịch sử lớp qua Resource API:', error.message);
      return [];
    }

    const scopes = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.class_id) continue;
      const key = `${row.class_id}:${row.school_year_id || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let metadata = null;
      try {
        // Dùng service key cho fallback Resource API, tránh Frappe xử lý Guardian JWT như session.
        metadata = await this.getClassMetadata(row.class_id, null);
      } catch (error) {
        console.warn('[FrappeService] Không lấy được metadata lớp của học sinh:', error.message);
      }

      scopes.push({
        classId: row.class_id,
        schoolYearId: row.school_year_id || metadata?.schoolYearId,
        classType: row.class_type || metadata?.classType,
        classTitle: metadata?.classTitle || row.class_id,
        schoolYearTitle: metadata?.schoolYearTitle || row.school_year_id,
        campusId: metadata?.campusId,
      });
    }

    return scopes;
  }

  async getCurrentGuardianData(token) {
    const response = await this.api.get(
      '/api/method/erp.api.parent_portal.otp_auth.get_current_guardian_comprehensive_data',
      { headers: this.buildParentPortalAuthHeaders(token) }
    );
    return response.data?.message || response.data;
  }

  async verifyGuardianStudentAccess(studentId, token) {
    // Không dùng Resource API để verify quan hệ guardian-student vì service key có thể thiếu quyền
    // hoặc vô tình bỏ qua rule truy cập. Scope method của Frappe sẽ kiểm tra quan hệ khi đã deploy.
    const decoded = this.verifyParentPortalToken(token);
    return Boolean(decoded?.guardian && (decoded?.email || decoded?.sub));
  }

  async authenticateParentGuardian(token) {
    const data = await this.getCurrentGuardianData(token);
    const payload = data?.data || data;
    const guardian = payload?.guardian;
    const portalUser = payload?.user;

    if (!guardian && !portalUser) {
      throw new Error('Parent portal user not found');
    }

    const email =
      portalUser?.email ||
      guardian?.email ||
      (guardian?.guardian_id ? `${guardian.guardian_id}@parent.wellspring.edu.vn` : undefined) ||
      guardian?.name;

    if (!email) {
      throw new Error('Parent portal user email is missing');
    }

    const guardianKeys = new Set(
      [guardian?.name, guardian?.guardian_id, guardian?.guardian_name]
        .map((value) => (value || '').toString().trim())
        .filter(Boolean)
    );
    const guardianImageFromRelationships = (payload?.families || [])
      .flatMap((family) => family?.relationships || [])
      .find((relationship) => {
        const details = relationship?.guardian_details;
        return [
          details?.name,
          details?.guardian_id,
          details?.guardian_name,
          relationship?.guardian_name,
        ]
          .map((value) => (value || '').toString().trim())
          .some((value) => value && guardianKeys.has(value));
      })?.guardian_details?.guardian_image;
    const guardianImage = guardianImageFromRelationships || guardian?.guardian_image || portalUser?.guardian_image || '';

    return {
      name: email,
      email,
      full_name: portalUser?.full_name || guardian?.guardian_name || guardian?.name || email,
      guardian_id: guardian?.guardian_id,
      guardian_image: guardianImage,
      avatar: guardianImage,
      roles: ['Parent Portal User'],
      enabled: 1,
      docstatus: 0,
      user_type: 'Website User',
    };
  }

  /**
   * 📨 Gửi Wislife notification đến Frappe
   * Pattern giống ticket-service: local auth với headers X-Service-Name và X-Request-Source
   * @param {string} eventType - Event type (e.g., 'new_post_broadcast', 'post_reacted')
   * @param {Object} eventData - Event data
   */
  async sendWislifeNotification(eventType, eventData) {
    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 10000; // 10 giây - Frappe chỉ enqueue job, respond nhanh
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[FrappeService] 📱 Sending Wislife notification: ${eventType} (attempt ${attempt}/${MAX_RETRIES})`);
        
        const response = await axios.post(
          `${this.baseURL}/api/method/erp.api.notification.wislife.handle_wislife_event`,
          {
            event_type: eventType,
            event_data: eventData
          },
          {
            timeout: TIMEOUT_MS,
            headers: {
              'X-Service-Name': 'social-service',
              'X-Request-Source': 'service-to-service',
              'Content-Type': 'application/json'
            }
          }
        );

        if (response.data?.message?.success !== false) {
          console.log(`[FrappeService] ✅ Wislife notification sent: ${eventType}`);
          return { success: true };
        } else {
          console.warn(`[FrappeService] ⚠️ Wislife notification response:`, response.data);
          return { success: false, message: response.data?.message };
        }
      } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        console.error(`[FrappeService] ❌ Notification failed (${eventType}), attempt ${attempt}: ${error.message}`);
        
        // Retry nếu timeout và chưa hết retry
        if (isTimeout && attempt < MAX_RETRIES) {
          console.log(`[FrappeService] 🔄 Retrying in 2 seconds...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        if (error.response) {
          console.error(`[FrappeService] Response status: ${error.response.status}`);
        }
        return { success: false, message: error.message };
      }
    }
    return { success: false, message: 'Max retries exceeded' };
  }
}

module.exports = new FrappeService();

