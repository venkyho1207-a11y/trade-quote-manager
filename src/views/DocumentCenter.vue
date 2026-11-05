<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Document, Printer, Search, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'
import type { DocumentPreview, DocumentTemplate, Quote } from '../types/domain'
import TemplatePreview from '../components/TemplatePreview.vue'

const rows = ref<Quote[]>([]); const templates = ref<DocumentTemplate[]>([])
const keyword = ref('')
const visible = ref(false); const selected = ref<Quote | null>(null)
// 预览改用单证模板渲染，与「生成单证」保持一致，不再用写死的 HTML 版面
const previewTemplateId = ref('')
const preview = ref<DocumentPreview | null>(null)
const previewLoading = ref(false)

// 搜索：客户名 + 单号 + 客户代码，命中其一即可
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return rows.value
  return rows.value.filter((row) => `${row.quoteNo} ${row.customerName} ${row.customerCode}`.toLowerCase().includes(kw))
})
const selectedTemplate = computed(() => templates.value.find((t) => t.id === previewTemplateId.value) ?? null)

async function load() {
  [rows.value, templates.value] = await Promise.all([api.quotes.list(), api.documents.templates.list()])
  // 默认选中第一份模板，打开预览就能看到内容
  if (!previewTemplateId.value) previewTemplateId.value = templates.value[0]?.id ?? ''
}
async function open(row: Quote) {
  selected.value = row; visible.value = true; preview.value = null
  if (previewTemplateId.value) await renderPreview()
}
async function renderPreview() {
  if (!selected.value || !previewTemplateId.value) return
  previewLoading.value = true
  try { preview.value = await api.documents.preview(selected.value.id, previewTemplateId.value) }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { previewLoading.value = false }
}
async function download() {
  if (!selected.value || !selectedTemplate.value) return ElMessage.warning('请先选择单证模板')
  try {
    await api.documents.generate(selected.value.id, selectedTemplate.value.id, `${selectedTemplate.value.name}_${selected.value.quoteNo}.xlsx`)
    ElMessage.success('已下载')
  } catch (error) { ElMessage.error((error as Error).message) }
}
function print() { window.print() }
onMounted(() => load().catch((error) => ElMessage.error(error.message)))
</script>
<template>
  <div class="page-view">
    <div class="page-heading">
      <div><h1>单证中心</h1><p>按单证模板查看报价单 / PI，可打印成 PDF 或直接下载 Excel</p></div>
      <div class="heading-actions">
        <el-select v-model="previewTemplateId" placeholder="选择模板" style="width: 200px" @change="selected && renderPreview()">
          <el-option v-for="t in templates" :key="t.id" :label="`${t.name}（${t.docType}）`" :value="t.id"/>
        </el-select>
      </div>
    </div>

    <el-card class="content-card" shadow="never">
      <div class="filter-bar">
        <el-input v-model="keyword" clearable :prefix-icon="Search" placeholder="搜索客户名称、单号或客户代码"/>
        <span class="muted">共 {{ filtered.length }} 张</span>
      </div>
      <el-table :data="filtered" empty-text="没有匹配的单证">
        <el-table-column prop="quoteNo" label="单号" width="190"/>
        <el-table-column prop="customerName" label="客户" min-width="180"/>
        <el-table-column label="单证类型" width="150">
          <template #default="{ row }"><el-tag :type="row.tradeTerm === 'CIF' ? 'success' : 'primary'"><el-icon><Document/></el-icon> {{ row.tradeTerm === 'CIF' ? 'PI' : '报价单' }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="tradeTerm" label="贸易术语" width="110"/>
        <el-table-column label="金额" width="150"><template #default="{ row }">{{ row.currency === 'USD' ? 'USD' : 'CNY' }} {{ (row.totalAmount / (row.currency === 'USD' ? row.exchangeRate || 1 : 1)).toFixed(2) }}</template></el-table-column>
        <el-table-column prop="updatedAt" label="日期" width="130"/>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="View" @click="open(row)">预览</el-button>
            <el-button link :icon="Download" @click="selected = row; download()">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="visible" title="单证预览" width="min(1300px, 96vw)" top="3vh">
      <div v-if="templates.length === 0" class="empty-hint">
        <el-empty description="还没有单证模板，请先到「单证模板」上传并配置映射" :image-size="80"/>
      </div>
      <div v-else v-loading="previewLoading">
        <div class="preview-bar">
          <span class="muted">{{ selected?.quoteNo }} — {{ selected?.customerName }}　模板：{{ selectedTemplate?.name }}</span>
          <div class="preview-actions">
            <el-button size="small" :icon="Printer" @click="print">打印 / PDF</el-button>
            <el-button size="small" type="primary" :icon="Download" @click="download">下载 Excel</el-button>
          </div>
        </div>
        <TemplatePreview v-if="preview" :rows="preview.rows" :merges="preview.merges" :column-count="preview.columnCount" :image-count="preview.imageCount"/>
      </div>
      <template #footer><el-button @click="visible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.heading-actions { display: flex; align-items: center; gap: 12px; }
.muted { color: #909399; font-size: 12px; }
.preview-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 12px; flex-wrap: wrap; }
.preview-actions { display: flex; gap: 8px; }
.empty-hint { padding: 20px 0; }
</style>
