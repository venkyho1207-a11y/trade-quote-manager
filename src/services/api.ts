import type { Customer, CustomerFollowUp, DocFieldGroup, DocumentPreview, DocumentTemplate, ExchangeRate, MyCompany, Product, Quote, QuoteDocumentFields, Supplier, TemplateStructureSheet } from '../types/domain'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

// 401 统一广播给 App，由根组件切到登录页；各视图不用各自处理登录失效
export const AUTH_EXPIRED_EVENT = 'auth:expired'
function notifyExpired() { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)) }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    // credentials: same-origin 让 httpOnly 会话 Cookie 随请求发送
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) notifyExpired()
    const error = await response.json().catch(() => ({ message: '请求失败' }))
    throw new Error(error.message ?? '请求失败')
  }
  return response.json() as Promise<T>
}

export const api = {
  auth: {
    me: () => request<{ user: { id: string; username: string; displayName: string } }>('/auth/me'),
    login: (username: string, password: string) => request<{ user: { id: string; username: string; displayName: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
    changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  },
  products: {
    list: () => request<Product[]>('/products'),
    create: (data: Omit<Product, 'id' | 'suppliers' | 'createdAt' | 'updatedAt'>) => request<Product>('/products', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Product>) => request<Product>(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: true }>(`/products/${id}`, { method: 'DELETE' }),
    addInquiry: (id: string, data: { supplierId: string; quote: number; inquiryDate: string; note: string }) => request('/products/inquiries', { method: 'POST', body: JSON.stringify({ productId: id, ...data }) }),
  },
  suppliers: {
    list: () => request<Supplier[]>('/suppliers'),
    create: (data: Omit<Supplier, 'id' | 'createdAt'>) => request<Supplier>('/suppliers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Supplier>) => request<Supplier>(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: true }>(`/suppliers/${id}`, { method: 'DELETE' }),
  },
  customers: {
    list: () => request<Customer[]>('/customers'),
    create: (data: Omit<Customer, 'id' | 'lastFollowUpAt' | 'nextFollowUpAt' | 'followupStage' | 'daysLeft' | 'createdAt'>) => request<Customer>('/customers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Customer>) => request<Customer>(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: true }>(`/customers/${id}`, { method: 'DELETE' }),
    followUps: (id: string) => request<CustomerFollowUp[]>(`/customers/${id}/follow-ups`),
    addFollowUp: (id: string, data: { followedAt: string; content: string }) => request<{ followup: CustomerFollowUp; customer: Customer }>(`/customers/${id}/follow-ups`, { method: 'POST', body: JSON.stringify(data) }),
    removeFollowUp: (id: string, followUpId: string) => request<{ ok: true; customer: Customer }>(`/customers/${id}/follow-ups/${followUpId}`, { method: 'DELETE' }),
  },
  quotes: {
    list: () => request<Quote[]>('/quotes'),
    get: (id: string) => request<Quote>(`/quotes/${id}`),
    create: (data: unknown) => request<Quote>('/quotes', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: unknown) => request<Quote>(`/quotes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  exchangeRate: {
    get: () => request<ExchangeRate>('/exchange-rate'),
    set: (rate: number) => request<ExchangeRate>('/exchange-rate', { method: 'POST', body: JSON.stringify({ rate }) }),
  },
  documents: {
    fields: () => request<DocFieldGroup[]>('/document-fields'),
    myCompany: {
      get: () => request<MyCompany>('/my-company'),
      save: (data: Omit<MyCompany, 'id' | 'updatedAt'>) => request<MyCompany>('/my-company', { method: 'PUT', body: JSON.stringify(data) }),
    },
    templates: {
      list: () => request<DocumentTemplate[]>('/document-templates'),
      // 模板上传是 multipart，不能走默认 JSON 请求头
      upload: async (file: File, name: string, docType: string) => {
        const body = new FormData()
        body.append('file', file); body.append('name', name); body.append('docType', docType)
        const response = await fetch(`${API_BASE}/document-templates`, { method: 'POST', body, credentials: 'same-origin' })
        if (!response.ok) { const error = await response.json().catch(() => ({ message: '上传失败' })); throw new Error(error.message ?? '上传失败') }
        return response.json() as Promise<DocumentTemplate>
      },
      update: (id: string, data: { name?: string; docType?: string; mapping?: unknown }) => request<DocumentTemplate>(`/document-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      remove: (id: string) => request<{ ok: true }>(`/document-templates/${id}`, { method: 'DELETE' }),
      structure: (id: string) => request<{ sheets: TemplateStructureSheet[] }>(`/document-templates/${id}/structure`),
    },
    quoteFields: {
      get: (quoteId: string) => request<QuoteDocumentFields>(`/quotes/${quoteId}/document-fields`),
      save: (quoteId: string, data: QuoteDocumentFields) => request<QuoteDocumentFields>(`/quotes/${quoteId}/document-fields`, { method: 'PUT', body: JSON.stringify(data) }),
    },
    // 预览：返回填充后的二维文本行，前端渲染成表格核对
    preview: (quoteId: string, templateId: string) => request<DocumentPreview>(`/quotes/${quoteId}/documents/preview`, { method: 'POST', body: JSON.stringify({ templateId }) }),
    // 生成单证返回二进制 xlsx，直接触发浏览器下载
    generate: async (quoteId: string, templateId: string, fileName: string) => {
      const response = await fetch(`${API_BASE}/quotes/${quoteId}/documents/generate`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId }),
      })
      if (!response.ok) { const error = await response.json().catch(() => ({ message: '生成失败' })); throw new Error(error.message ?? '生成失败') }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = fileName; link.click()
      URL.revokeObjectURL(url)
    },
  },
}
