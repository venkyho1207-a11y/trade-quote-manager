<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Download, Document, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'
import type { DocumentPreview, DocumentTemplate, Quote, QuoteDocumentFields } from '../types/domain'
import TemplatePreview from '../components/TemplatePreview.vue'

const quotes = ref<Quote[]>([]); const templates = ref<DocumentTemplate[]>([])
const selectedQuoteId = ref(''); const selectedTemplateId = ref('')
const fillVisible = ref(false); const generating = ref(false)
// 预览：先看填充结果再决定是否下载
const previewVisible = ref(false); const previewLoading = ref(false)
const preview = ref<DocumentPreview | null>(null)
const quote = computed(() => quotes.value.find((q) => q.id === selectedQuoteId.value) ?? null)
const template = computed(() => templates.value.find((t) => t.id === selectedTemplateId.value) ?? null)

// 弹窗里的非固定字段：默认从报价单已存记录带出，首次留空
const fields = reactive<QuoteDocumentFields>(emptyFields())
function emptyFields(): QuoteDocumentFields {
  return { from: '', to: '', vessel: '', marks: '', poNo: '', scNo: '', loadingDate: '', countryOfOrigin: 'CHINA', termOfDelivery: '', remark: '', items: {} }
}
function emptyItem() { return { unit: '', hsCode: '', ctns: '', gw: '', nw: '', cbm: '', size: '' } }
// 明细行的默认值：产品库里的单箱参数，以及按 总数量÷装箱数 推算的箱数/总毛净重
function itemDefaults(item: Quote['items'][number]) {
  const packQty = Number(item.packingQuantity) || 0
  const cartons = packQty > 0 ? Math.ceil(item.quantity / packQty) : 0
  const round2 = (value: number) => Math.round(value * 100) / 100
  return {
    unit: item.unit || 'PCS',
    hsCode: item.hsCode || '',
    ctns: cartons ? String(cartons) : '',
    gw: cartons && item.cartonGrossWeight ? String(round2(cartons * item.cartonGrossWeight)) : '',
    nw: cartons && item.cartonNetWeight ? String(round2(cartons * item.cartonNetWeight)) : '',
    cbm: cartons && item.cartonVolume ? String(round2(cartons * item.cartonVolume)) : '',
    size: item.cartonSize || '',
  }
}

async function load() { [quotes.value, templates.value] = await Promise.all([api.quotes.list(), api.documents.templates.list()]) }

// 选好报价单和模板后打开补全弹窗，产品库默认值与上次保存的覆盖值合并
async function openFill() {
  if (!selectedQuoteId.value || !selectedTemplateId.value) return ElMessage.warning('请先选择报价单和模板')
  try {
    const saved = await api.documents.quoteFields.get(selectedQuoteId.value)
    Object.assign(fields, emptyFields(), saved)
    // 先铺产品库默认值，再用上次保存值覆盖；用户清空的字段靠「空串」也保留，交给后端判断
    const items: QuoteDocumentFields['items'] = {}
    for (const item of quote.value?.items ?? []) items[item.productId] = { ...itemDefaults(item), ...(saved.items?.[item.productId] ?? {}) }
    fields.items = items
    fillVisible.value = true
  } catch (error) { ElMessage.error((error as Error).message) }
}
// 预览：先保存当前补充字段，再让后端按同一套逻辑渲染，保证看到的就是导出的
async function openPreview() {
  if (!quote.value || !template.value) return
  previewLoading.value = true
  try {
    await api.documents.quoteFields.save(quote.value.id, { ...fields })
    preview.value = await api.documents.preview(quote.value.id, template.value.id)
    previewVisible.value = true
  } catch (error) { ElMessage.error((error as Error).message) } finally { previewLoading.value = false }
}
async function generate() {
  if (!quote.value || !template.value) return
  generating.value = true
  try {
    await api.documents.quoteFields.save(quote.value.id, { ...fields })
    const fileName = `${template.value.name}_${quote.value.quoteNo}.xlsx`
    await api.documents.generate(quote.value.id, template.value.id, fileName)
    previewVisible.value = false; fillVisible.value = false; ElMessage.success('单证已下载，补充字段已保存')
  } catch (error) { ElMessage.error((error as Error).message) } finally { generating.value = false }
}
function money(value: number) { const q = quote.value; const rate = q && q.currency === 'USD' && q.exchangeRate > 0 ? q.exchangeRate : 1; return `${q?.currency === 'USD' ? '$' : '¥'}${(value / rate).toFixed(2)}` }

onMounted(() => load().catch((error) => ElMessage.error(error.message)))
</script>
<template>
  <div class="page-view">
    <div class="page-heading">
      <div><h1>生成单证</h1><p>选择报价单与模板，补齐起运地、唛头、商品编号等非固定字段后导出 Excel</p></div>
    </div>

    <el-card class="content-card" shadow="never">
      <el-form label-width="100px">
        <el-row :gutter="18">
          <el-col :xs="24" :sm="12">
            <el-form-item label="报价单">
              <el-select v-model="selectedQuoteId" filterable placeholder="选择要生成单证的报价单" style="width:100%">
                <el-option v-for="q in quotes" :key="q.id" :label="`${q.quoteNo} — ${q.customerName}`" :value="q.id"/>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="单证模板">
              <el-select v-model="selectedTemplateId" placeholder="选择模板" style="width:100%">
                <el-option v-for="t in templates" :key="t.id" :label="`${t.name}（${t.docType}）`" :value="t.id"/>
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <el-empty v-if="!templates.length" description="还没有模板，请先到「单证模板」上传并配置映射" :image-size="80"/>
      <div class="actions">
        <el-button type="primary" :icon="Edit" :disabled="!selectedQuoteId || !selectedTemplateId" @click="openFill">填写并生成</el-button>
      </div>
    </el-card>

    <el-card v-if="quote" class="content-card" shadow="never">
      <template #header><div class="card-title"><el-icon><Document/></el-icon><strong>{{ quote.quoteNo }} — {{ quote.customerName }}</strong></div></template>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="贸易术语">{{ quote.tradeTerm }}</el-descriptions-item>
        <el-descriptions-item label="模式">{{ quote.mode }}</el-descriptions-item>
        <el-descriptions-item label="币种">{{ quote.currency }}</el-descriptions-item>
        <el-descriptions-item label="总金额">{{ money(quote.totalAmount) }}</el-descriptions-item>
      </el-descriptions>
      <el-table :data="quote.items" size="small" style="margin-top:12px">
        <el-table-column prop="productName" label="产品" min-width="160"/>
        <el-table-column prop="model" label="型号" width="120"/>
        <el-table-column prop="sku" label="SKU" width="140"/>
        <el-table-column prop="quantity" label="数量" width="90"/>
        <el-table-column label="单价" width="120"><template #default="{ row }">{{ money(row.selectedUnitPrice) }}</template></el-table-column>
        <el-table-column label="小计" width="130"><template #default="{ row }">{{ money(row.totalPrice) }}</template></el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="fillVisible" title="补充单证字段" width="min(1100px, 96vw)" top="4vh" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon title="这些字段不固定，随报价单保存；下次生成同一张报价单会自动带出" style="margin-bottom:12px"/>
      <el-form label-width="120px">
        <el-row :gutter="16">
          <el-col :xs="12" :sm="6"><el-form-item label="起运地 From"><el-input v-model="fields.from"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="目的地 To"><el-input v-model="fields.to"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="船名/航次"><el-input v-model="fields.vessel"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="原产国"><el-input v-model="fields.countryOfOrigin"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="PO No."><el-input v-model="fields.poNo"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="S/C No."><el-input v-model="fields.scNo"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="发货时间"><el-input v-model="fields.loadingDate" placeholder="如 100 days after deposit"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="交货与付款"><el-input v-model="fields.termOfDelivery" placeholder="如 BY SEA AND T/T"/></el-form-item></el-col>
          <el-col :xs="24"><el-form-item label="唛头 Marks"><el-input v-model="fields.marks" type="textarea" :rows="2"/></el-form-item></el-col>
          <el-col :xs="24"><el-form-item label="备注"><el-input v-model="fields.remark" type="textarea" :rows="2"/></el-form-item></el-col>
        </el-row>
      </el-form>

      <!-- 商品明细补充：默认取产品库的单箱参数并自动累加，可临时覆盖 -->
      <el-divider content-position="left">商品明细补充（默认取产品库参数，可临时覆盖）</el-divider>
      <el-table :data="quote?.items ?? []" size="small">
        <el-table-column prop="productName" label="产品" min-width="140" fixed/>
        <el-table-column label="单位" width="80"><template #default="{ row }"><el-input v-model="fields.items[row.productId].unit" size="small" placeholder="产品库"/></template></el-table-column>
        <el-table-column label="商品编号 HS" width="130"><template #default="{ row }"><el-input v-model="fields.items[row.productId].hsCode" size="small" placeholder="产品库"/></template></el-table-column>
        <el-table-column label="件数 CTNS" width="105"><template #default="{ row }"><el-input v-model="fields.items[row.productId].ctns" size="small" placeholder="自动"/></template></el-table-column>
        <el-table-column label="毛重 G.W." width="105"><template #default="{ row }"><el-input v-model="fields.items[row.productId].gw" size="small" placeholder="自动"/></template></el-table-column>
        <el-table-column label="净重 N.W." width="105"><template #default="{ row }"><el-input v-model="fields.items[row.productId].nw" size="small" placeholder="自动"/></template></el-table-column>
        <el-table-column label="体积 CBM" width="105"><template #default="{ row }"><el-input v-model="fields.items[row.productId].cbm" size="small" placeholder="自动"/></template></el-table-column>
        <el-table-column label="外箱尺寸" width="130"><template #default="{ row }"><el-input v-model="fields.items[row.productId].size" size="small" placeholder="产品库"/></template></el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="fillVisible=false">取消</el-button>
        <el-button :loading="previewLoading" @click="openPreview">预览</el-button>
        <el-button type="primary" :icon="Download" :loading="generating" @click="generate">生成并下载</el-button>
      </template>
    </el-dialog>

    <!-- 单证预览：把后端填充后的表格原样展示，确认无误再下载 -->
    <el-dialog v-model="previewVisible" title="单证预览" width="min(1400px, 96vw)" top="3vh">
      <div v-loading="previewLoading">
        <el-alert v-if="!preview?.rows.length" type="warning" :closable="false" show-icon title="模板没有可预览的内容，请检查字段映射是否已配置"/>
        <div v-else class="preview-toolbar">
          <span class="muted">工作表：{{ preview.sheet }} ｜ 共 {{ preview.rows.length }} 行</span>
        </div>
        <div v-if="preview?.rows.length" class="preview-scroll">
          <TemplatePreview :rows="preview.rows" :merges="preview.merges" :column-count="preview.columnCount" :image-count="preview.imageCount"/>
        </div>
      </div>
      <template #footer>
        <el-button @click="previewVisible=false">返回修改</el-button>
        <el-button type="primary" :icon="Download" :loading="generating" @click="generate">确认并下载</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<style scoped>
.actions { margin-top: 8px; }
.card-title { display: flex; align-items: center; gap: 8px; }
.muted { color: #909399; font-size: 12px; }
.preview-toolbar { margin-bottom: 8px; }
.preview-scroll { max-height: 66vh; overflow: auto; }
</style>
