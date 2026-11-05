<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Delete, DocumentAdd, Edit, Plus, Printer, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'
import type { Customer, DocumentPreview, DocumentTemplate, Product, Quote, QuoteCurrency } from '../types/domain'
import TemplatePreview from '../components/TemplatePreview.vue'
import { calculateRecommendedPrices, roundMoney } from '../utils/quoteCalculator'

const products = ref<Product[]>([]); const customers = ref<Customer[]>([]); const quotes = ref<Quote[]>([]); const visible = ref(false); const editingId = ref<string | null>(null); const activeQuote = ref<Quote | null>(null)
const customerKeyword = ref('')
// 报价单预览改由单证模板渲染，模板列表在这里加载
const templates = ref<DocumentTemplate[]>([])
const previewTemplateId = ref('')
const previewData = ref<DocumentPreview | null>(null)
const previewLoading = ref(false)
const copySource = ref('')
const exchangeRate = ref(0); const exchangeSource = ref(''); const manualRate = ref<number | null>(null)

// 报价单表单：结算币种、汇率快照、单号 + 原有公共费用
const form = reactive({ customerId: '', quoteNo: '', mode: '散货' as '散货' | '整柜', tradeTerm: 'FOB' as 'EXW' | 'FOB' | 'CIF', domesticFreight: 0, customsFee: 0, bankFee: 0, oceanFreight: 0, insuranceFee: 0, paymentNote: '', currency: 'CNY' as QuoteCurrency, exchangeRate: 0 })
const rows = ref<Array<{ productId: string; quantity: number; packagingFee: number; profit: number; customPrice: number | null; priceCurrency: QuoteCurrency }>>([])

const selectedCustomer = computed(() => customers.value.find((item) => item.id === form.customerId))
const totalQuantity = computed(() => rows.value.reduce((sum, row) => sum + row.quantity, 0))
function product(id: string) { return products.value.find((item) => item.id === id) }

// 展示汇率：整单 USD 结算时按快照汇率换算，CNY 则原样
const displayRate = computed(() => (form.currency === 'USD' && form.exchangeRate > 0 ? form.exchangeRate : 1))
function moneySymbol() { return form.currency === 'USD' ? '$' : '¥' }
function money(value: number) { return `${moneySymbol()}${(value / displayRate.value).toFixed(2)}` }
// 行内手动价的币种 → 人民币：美元手动价按汇率换算回人民币参与内部计算
function toRmb(value: number, currency: QuoteCurrency) { return currency === 'USD' ? value * form.exchangeRate : value }

// 推荐单价（人民币基准，公式不变），展示时按整单币种换算
function recommendation(row: typeof rows.value[number]) { const item = product(row.productId); if (!item || !totalQuantity.value) return { exw: 0, fob: 0, cif: 0 }; return calculateRecommendedPrices({ quantity: totalQuantity.value, cost: item.cost, packagingFee: row.packagingFee, profit: row.profit, domesticFreight: form.domesticFreight, customsFee: form.customsFee, bankFee: form.bankFee, oceanFreight: form.oceanFreight, insuranceFee: form.insuranceFee }) }
function recommendedUnit(row: typeof rows.value[number]) { const rec = recommendation(row); return ({ EXW: rec.exw, FOB: rec.fob, CIF: rec.cif } as const)[form.tradeTerm] }
// 行人民币单价：手动价（按行币种换算）优先，否则取推荐价
function unitPriceRmb(row: typeof rows.value[number]) { return row.customPrice != null ? toRmb(row.customPrice, row.priceCurrency) : recommendedUnit(row) }
function lineTotals() { const cents = rows.value.map((row) => Math.round(unitPriceRmb(row) * row.quantity * 100)); const target = cents.reduce((sum, value) => sum + value, 0); if (cents.length) cents[cents.length - 1] = target - cents.slice(0, -1).reduce((sum, value) => sum + value, 0); return cents.map((value) => value / 100) }
function lineTotal(_row: typeof rows.value[number], index: number) { return lineTotals()[index] ?? 0 }
const totalAmountRmb = computed(() => roundMoney(lineTotals().reduce((sum, value) => sum + value, 0)))

// 按客户分档：左侧客户列表（可搜索），右侧该客户的历史报价单
const filteredCustomers = computed(() => customers.value.filter((row) => `${row.name} ${row.code} ${row.country} ${row.contact} ${row.salesperson}`.toLowerCase().includes(customerKeyword.value.toLowerCase())))
const selectedCustomerId = ref<string | null>(null)
const customerQuotes = computed(() => quotes.value.filter((q) => q.customerId === selectedCustomerId.value))
function selectCustomer(id: string) { selectedCustomerId.value = id }

async function loadExchangeRate() { try { const data = await api.exchangeRate.get(); exchangeRate.value = data.rate; exchangeSource.value = data.source; if (manualRate.value === null) manualRate.value = data.rate } catch (error) { ElMessage.error((error as Error).message) } }
async function refreshExchangeRate() { await loadExchangeRate(); ElMessage.success(`当前汇率 ${exchangeRate.value}（${exchangeSource.value}）`) }
async function saveManualRate() { if (!manualRate.value || manualRate.value <= 0) return ElMessage.warning('请输入正数汇率'); try { const data = await api.exchangeRate.set(manualRate.value); exchangeRate.value = data.rate; exchangeSource.value = data.source; ElMessage.success('汇率已更新') } catch (error) { ElMessage.error((error as Error).message) } }

function reset() { copySource.value = ''; Object.assign(form, { customerId: customers.value[0]?.id ?? '', quoteNo: '', mode: '散货', tradeTerm: 'FOB', domesticFreight: 0, customsFee: 0, bankFee: 0, oceanFreight: 0, insuranceFee: 0, paymentNote: '', currency: 'CNY' as QuoteCurrency, exchangeRate: exchangeRate.value || 7.1 }); rows.value = products.value.slice(0, 1).map((item) => ({ productId: item.id, quantity: 1, packagingFee: 0, profit: 0, customPrice: null, priceCurrency: 'CNY' as QuoteCurrency })) }
function create() { editingId.value = null; activeQuote.value = null; reset(); visible.value = true }
function edit(quote: Quote) { editingId.value = quote.id; copySource.value = ''; Object.assign(form, { customerId: quote.customerId, quoteNo: quote.quoteNo, mode: quote.mode, tradeTerm: quote.tradeTerm, domesticFreight: quote.domesticFreight, customsFee: quote.customsFee, bankFee: quote.bankFee, oceanFreight: quote.oceanFreight, insuranceFee: quote.insuranceFee, paymentNote: quote.paymentNote, currency: quote.currency, exchangeRate: quote.exchangeRate || exchangeRate.value || 7.1 }); rows.value = quote.items.map((item) => ({ productId: item.productId, quantity: item.quantity, packagingFee: item.packagingFee, profit: item.profit, customPrice: item.priceCurrency === 'USD' ? item.selectedUnitPrice / (quote.exchangeRate || 1) : item.selectedUnitPrice, priceCurrency: item.priceCurrency })); visible.value = true }

// 下拉选择该客户已有报价单号 → 复制其内容为新报价单（清空 editingId、quoteNo 留空，后端自动生成新单号）
const previousQuotes = computed(() => quotes.value.filter((q) => q.customerId === form.customerId && q.id !== editingId.value))
function copyFromQuote(quoteNo: string) { const source = previousQuotes.value.find((q) => q.quoteNo === quoteNo); if (!source) return; editingId.value = null; Object.assign(form, { customerId: source.customerId, quoteNo: '', mode: source.mode, tradeTerm: source.tradeTerm, domesticFreight: source.domesticFreight, customsFee: source.customsFee, bankFee: source.bankFee, oceanFreight: source.oceanFreight, insuranceFee: source.insuranceFee, paymentNote: source.paymentNote, currency: source.currency, exchangeRate: source.exchangeRate || exchangeRate.value || 7.1 }); rows.value = source.items.map((item) => ({ productId: item.productId, quantity: item.quantity, packagingFee: item.packagingFee, profit: item.profit, customPrice: item.priceCurrency === 'USD' ? item.selectedUnitPrice / (source.exchangeRate || 1) : item.selectedUnitPrice, priceCurrency: item.priceCurrency })) }

function addRow() { const item = products.value.find((candidate) => !rows.value.some((row) => row.productId === candidate.id)); if (item) rows.value.push({ productId: item.id, quantity: 1, packagingFee: 0, profit: 0, customPrice: null, priceCurrency: form.currency }) }
function removeRow(index: number) { rows.value.splice(index, 1) }
async function save() { if (!form.customerId || !rows.value.length || rows.value.some((row) => !row.productId || row.quantity <= 0)) return ElMessage.warning('请选择客户、产品并填写正数数量'); try { const data = { ...form, exchangeRate: form.exchangeRate || 1, items: rows.value.map((row) => ({ productId: row.productId, quantity: row.quantity, packagingFee: row.packagingFee, profit: row.profit, customExw: form.tradeTerm === 'EXW' ? row.customPrice : null, customFob: form.tradeTerm === 'FOB' ? row.customPrice : null, customCif: form.tradeTerm === 'CIF' ? row.customPrice : null, priceCurrency: row.priceCurrency })) }; const saved = editingId.value ? await api.quotes.update(editingId.value, data) : await api.quotes.create(data); await load(); visible.value = false; activeQuote.value = saved; selectedCustomerId.value = saved.customerId; ElMessage.success('报价单已保存') } catch (error) { ElMessage.error((error as Error).message) } }
async function load() { [products.value, customers.value, quotes.value, templates.value] = await Promise.all([api.products.list(), api.customers.list(), api.quotes.list(), api.documents.templates.list()]) }
function preview(quote: Quote) {
  activeQuote.value = quote
  // 报价单预览同样走单证模板：所有单证共用一套映射，样式改模板即可
  previewTemplateId.value = previewTemplateId.value || templates.value[0]?.id || ''
  renderPreview()
}
async function renderPreview() {
  if (!activeQuote.value || !previewTemplateId.value) return
  previewLoading.value = true
  try { previewData.value = await api.documents.preview(activeQuote.value.id, previewTemplateId.value) }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { previewLoading.value = false }
}
function print() { window.print() }
watch(() => form.tradeTerm, () => rows.value.forEach((row) => { row.customPrice = null }))
onMounted(async () => { await Promise.all([load(), loadExchangeRate()]).catch((error) => ElMessage.error((error as Error).message)) })
</script>
<template><div class="page-view"><div class="page-heading"><div><h1>报价管理</h1><p>按客户归档报价单；支持人民币/美元结算与实时汇率；新建报价单后自动为客户记录发送日程</p></div><div class="heading-actions"><div class="rate-bar"><span>美元汇率：<strong>{{ exchangeRate.toFixed(4) }}</strong>（{{ exchangeSource }}）</span><el-input-number v-model="manualRate" :min="0" :precision="4" :step="0.01" controls-position="right" size="small" style="width:130px"/><el-button size="small" @click="saveManualRate">应用</el-button><el-button size="small" :icon="Refresh" @click="refreshExchangeRate">刷新</el-button></div><el-button type="primary" :icon="Plus" @click="create">新建报价单</el-button></div></div>
<div class="quote-layout"><el-card class="content-card quote-customers" shadow="never"><div class="filter-bar"><el-input v-model="customerKeyword" clearable :prefix-icon="Search" placeholder="搜索客户"/></div><el-table :data="filteredCustomers" highlight-current-row @current-change="(row: Customer | null) => row && selectCustomer(row.id)"><el-table-column prop="code" label="代码" width="90"/><el-table-column prop="name" label="客户" min-width="140"/><el-table-column prop="country" label="国家" width="80"/><el-table-column label="报价数" width="70"><template #default="{ row }">{{ quotes.filter((q) => q.customerId === row.id).length }}</template></el-table-column></el-table></el-card>
<el-card class="content-card quote-list" shadow="never"><div v-if="selectedCustomerId" class="quote-list-head"><strong>{{ customers.find((c) => c.id === selectedCustomerId)?.name }}</strong><span class="muted">共 {{ customerQuotes.length }} 张报价单</span></div><el-empty v-else description="请选择左侧客户查看报价单"/><el-table v-if="selectedCustomerId" :data="customerQuotes"><el-table-column prop="quoteNo" label="报价单号" width="180"/><el-table-column prop="mode" label="模式" width="80"/><el-table-column prop="tradeTerm" label="术语" width="80"/><el-table-column label="币种" width="80"><template #default="{ row }">{{ row.currency === 'USD' ? '美元' : '人民币' }}</template></el-table-column><el-table-column prop="totalQuantity" label="总数量" width="90"/><el-table-column label="总报价" width="140"><template #default="{ row }">{{ row.currency === 'USD' ? '$' : '¥' }}{{ row.totalAmount.toFixed(2) }}</template></el-table-column><el-table-column prop="updatedAt" label="更新时间" width="120"/><el-table-column label="操作" width="190" fixed="right"><template #default="{ row }"><el-button link :icon="DocumentAdd" @click="preview(row)">预览</el-button><el-button link :icon="Edit" @click="edit(row)">编辑</el-button><el-button link type="primary" :icon="Printer" @click="activeQuote=row; print()">打印</el-button></template></el-table-column></el-table></el-card></div>
<el-dialog v-model="visible" title="创建报价单" width="min(1500px, 96vw)" top="4vh"><el-form label-width="100px"><el-row :gutter="18"><el-col :xs="24" :sm="12" :md="8"><el-form-item label="选择客户"><el-select v-model="form.customerId" class="full-width"><el-option v-for="item in customers" :key="item.id" :label="`${item.name}（${item.code}）`" :value="item.id"/></el-select></el-form-item></el-col><el-col :xs="24" :sm="12" :md="8"><el-form-item label="报价单号"><el-input v-model="form.quoteNo" placeholder="留空自动生成"/></el-form-item></el-col><el-col :xs="24" :sm="12" :md="8"><el-form-item label="复制已有单"><el-select v-model="copySource" class="full-width" clearable placeholder="选该客户已有报价单复制" @change="copyFromQuote"><el-option v-for="q in previousQuotes" :key="q.id" :label="q.quoteNo" :value="q.quoteNo"/></el-select></el-form-item></el-col></el-row><el-row :gutter="18"><el-col :xs="12" :sm="6"><el-form-item label="模式"><el-radio-group v-model="form.mode"><el-radio-button label="散货"/><el-radio-button label="整柜"/></el-radio-group></el-form-item></el-col><el-col :xs="12" :sm="6"><el-form-item label="贸易术语"><el-radio-group v-model="form.tradeTerm"><el-radio-button label="EXW"/><el-radio-button label="FOB"/><el-radio-button label="CIF"/></el-radio-group></el-form-item></el-col><el-col :xs="12" :sm="8"><el-form-item label="结算币种"><el-radio-group v-model="form.currency"><el-radio-button label="CNY">人民币</el-radio-button><el-radio-button label="USD">美元</el-radio-button></el-radio-group></el-form-item></el-col><el-col :xs="12" :sm="4"><el-form-item label="汇率快照"><el-input-number v-model="form.exchangeRate" :min="0" :precision="4" :step="0.01" class="full-width" controls-position="right"/></el-form-item></el-col></el-row></el-form><el-divider content-position="left">整单公共费用（按商品总数量分摊，人民币）</el-divider><el-form label-position="top"><el-row :gutter="14"><el-col :xs="12" :sm="8" :md="5"><el-form-item label="国内运费"><el-input-number v-model="form.domesticFreight" :min="0" :precision="2" class="full-width" controls-position="right"/></el-form-item></el-col><el-col :xs="12" :sm="8" :md="5"><el-form-item label="报关费"><el-input-number v-model="form.customsFee" :min="0" :precision="2" class="full-width" controls-position="right"/></el-form-item></el-col><el-col :xs="12" :sm="8" :md="5"><el-form-item label="银行手续费"><el-input-number v-model="form.bankFee" :min="0" :precision="2" class="full-width" controls-position="right"/></el-form-item></el-col><el-col :xs="12" :sm="8" :md="5"><el-form-item label="海运费"><el-input-number v-model="form.oceanFreight" :min="0" :precision="2" class="full-width" controls-position="right"/></el-form-item></el-col><el-col :xs="12" :sm="8" :md="4"><el-form-item label="保险费"><el-input-number v-model="form.insuranceFee" :min="0" :precision="2" class="full-width" controls-position="right"/></el-form-item></el-col></el-row></el-form><div class="quote-table-header"><strong>报价产品明细</strong><el-button link type="primary" :icon="Plus" @click="addRow">添加产品</el-button></div><div class="quote-items-scroll"><el-table :data="rows" border><el-table-column label="产品" min-width="200"><template #default="{ row }"><el-select v-model="row.productId" class="full-width"><el-option v-for="item in products" :key="item.id" :label="`${item.name}（${item.sku}）`" :value="item.id"/></el-select></template></el-table-column><el-table-column label="数量" width="110"><template #default="{ row }"><el-input-number v-model="row.quantity" :min="1" controls-position="right"/></template></el-table-column><el-table-column label="包装费/件" width="130"><template #default="{ row }"><el-input-number v-model="row.packagingFee" :min="0" :precision="2" controls-position="right"/></template></el-table-column><el-table-column label="利润/件" width="130"><template #default="{ row }"><el-input-number v-model="row.profit" :min="0" :precision="2" controls-position="right"/></template></el-table-column><el-table-column label="推荐单价" width="130"><template #default="{ row }">{{ money(recommendedUnit(row)) }}</template></el-table-column><el-table-column label="手动单价" width="200"><template #default="{ row }"><el-input-number v-model="row.customPrice" :min="0" :precision="2" placeholder="跟随推荐" controls-position="right" style="width:120px"/><el-select v-model="row.priceCurrency" size="small" style="width:70px;margin-left:4px"><el-option label="¥" value="CNY"/><el-option label="$" value="USD"/></el-select></template></el-table-column><el-table-column label="小计" width="130"><template #default="{ row, $index }">{{ money(lineTotal(row, $index)) }}</template></el-table-column><el-table-column width="55"><template #default="{ $index }"><el-button link type="danger" :icon="Delete" @click="removeRow($index)"/></template></el-table-column></el-table></div><div class="quote-total">总数量：<strong>{{ totalQuantity }}</strong> 件　总报价：<strong>{{ money(totalAmountRmb) }}</strong></div><el-form label-width="100px"><el-form-item label="付款备注"><el-input v-model="form.paymentNote" type="textarea" placeholder="付款方式、交期等备注"/></el-form-item></el-form><template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" @click="save">保存报价单</el-button></template></el-dialog>
<el-dialog v-model="activeQuote" title="单证预览" width="min(1300px, 96vw)" top="3vh"><div v-loading="previewLoading" class="quote-doc-preview"><div class="doc-preview-bar"><el-select v-model="previewTemplateId" size="small" placeholder="选择模板" style="width:200px" @change="renderPreview"><el-option v-for="t in templates" :key="t.id" :label="`${t.name}（${t.docType}）`" :value="t.id"/></el-select><el-button size="small" :icon="Printer" @click="print">打印 / 下载PDF</el-button></div><el-empty v-if="!templates.length" description="还没有单证模板，请先到「单证模板」上传并配置映射" :image-size="80"/><TemplatePreview v-else-if="previewData" :rows="previewData.rows" :merges="previewData.merges" :column-count="previewData.columnCount" :image-count="previewData.imageCount"/></div></el-dialog></div></template>
<style scoped>
.heading-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.rate-bar { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #606266; flex-wrap: wrap; }
.quote-layout { display: flex; gap: 16px; align-items: stretch; flex-wrap: wrap; }
.quote-customers { flex: 0 0 300px; min-width: 0; }
.quote-list { flex: 1 1 360px; min-width: 0; }
.quote-list-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.muted { color: #909399; font-size: 13px; }
.quote-items-scroll { overflow-x: auto; }
.quote-items-scroll .el-table { min-width: 900px; }
.quote-doc-preview { min-height: 300px; }
.doc-preview-bar { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-bottom: 10px; }
</style>
