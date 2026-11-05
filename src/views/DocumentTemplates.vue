<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Delete, Document, Download, Edit, Plus, Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../services/api'
import type { DocFieldGroup, DocType, DocumentTemplate, TemplateMapping, TemplateStructureSheet } from '../types/domain'

const templates = ref<DocumentTemplate[]>([]); const fieldGroups = ref<DocFieldGroup[]>([])
const DOC_TYPES: DocType[] = ['PI', '报价单', '商业发票', '装箱单', '报关单', '其他']

const uploadVisible = ref(false); const uploadForm = ref({ name: '', docType: 'PI' as DocType, file: null as File | null })

// 映射编辑：选中模板 → 解析结构 → 在网格里点格子树绑定
const mappingVisible = ref(false); const editing = ref<DocumentTemplate | null>(null)
const sheets = ref<TemplateStructureSheet[]>([]); const activeSheet = ref('')
const mapping = ref<TemplateMapping>({ sheet: '', cells: {}, items: { startRow: 0, columns: {} } })
const selectedCell = ref<string>('')
const pendingField = ref('')
// 明细区模式：开启后，点选的格子会被记录为「明细列」，而不是静态字段
const itemMode = ref(false)
const structureLoading = ref(false)

const currentSheet = computed(() => sheets.value.find((s) => s.name === activeSheet.value) ?? null)
// 按行列还原成网格，便于表格化展示模板版面
const grid = computed(() => {
  const sheet = currentSheet.value
  if (!sheet) return []
  const rows: Array<Array<{ address: string; text: string; rowSpan: number; colSpan: number; hidden: boolean }>> = []
  const merged = new Map<string, { rowSpan: number; colSpan: number }>()
  const hidden = new Set<string>()
  for (const range of sheet.merges) {
    const [start, end] = range.split(':'); const endAddr = end || start
    const s = parseAddress(start); const e = parseAddress(endAddr)
    if (!s || !e) continue
    merged.set(coord(s.row, s.col), { rowSpan: e.row - s.row + 1, colSpan: e.col - s.col + 1 })
    for (let r = s.row; r <= e.row; r += 1) for (let c = s.col; c <= e.col; c += 1) {
      if (r === s.row && c === s.col) continue
      hidden.add(coord(r, c))
    }
  }
  const cellMap = new Map(sheet.cells.map((cell) => [cell.address, cell.text]))
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row: Array<any> = []
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const address = `${colLetter(c)}${r}`
      const span = merged.get(coord(r, c))
      row.push({ address, text: cellMap.get(address) ?? '', rowSpan: span?.rowSpan ?? 1, colSpan: span?.colSpan ?? 1, hidden: hidden.has(coord(r, c)) })
    }
    rows.push(row)
  }
  return rows
})
function coord(row: number, col: number) { return `${row}:${col}` }
function parseAddress(address: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(address).replace(/\$/g, '').toUpperCase())
  if (!match) return null
  let col = 0; for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]), col }
}
function colLetter(index: number) { let s = ''; let n = index; while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26) } return s }
// 已绑定字段反查：格子 → 字段名，用于在网格上打标签
const cellLabel = (address: string) => {
  const spec = mapping.value.cells?.[address]
  if (!spec) return ''
  if (typeof spec === 'string') return fieldLabel(spec)
  if (spec.block) return `块：${spec.block.filter(Boolean).map(fieldLabel).join(' / ')}`
  return spec.field ? fieldLabel(spec.field) : ''
}
const itemColumnLabel = (address: string) => {
  const sheet = currentSheet.value; if (!sheet) return ''
  const cell = sheet.cells.find((c) => c.address === address); if (!cell) return ''
  const field = mapping.value.items?.columns?.[String(cell.col)]
  return field ? fieldLabel(field) : ''
}
function fieldLabel(key: string) {
  for (const group of fieldGroups.value) for (const [value, label] of group.items) if (value === key) return label
  return key
}

async function load() { templates.value = await api.documents.templates.list() }

function openUpload() { uploadForm.value = { name: '', docType: 'PI', file: null }; uploadVisible.value = true }
function onFileChange(uploadFile: { raw?: File }) { uploadForm.value.file = uploadFile.raw ?? null }
async function submitUpload() {
  if (!uploadForm.value.file) return ElMessage.warning('请选择 .xlsx 模板文件')
  try {
    const template = await api.documents.templates.upload(uploadForm.value.file, uploadForm.value.name || uploadForm.value.file.name.replace(/\.xlsx$/i, ''), uploadForm.value.docType)
    uploadVisible.value = false; await load(); ElMessage.success('模板已上传，请配置字段映射'); openMapping(template)
  } catch (error) { ElMessage.error((error as Error).message) }
}

async function openMapping(template: DocumentTemplate) {
  editing.value = template; mapping.value = { sheet: '', cells: {}, items: { startRow: 0, columns: {} }, ...(template.mapping || {}) }
  selectedCell.value = ''; pendingField.value = ''; itemMode.value = false; mappingVisible.value = true
  structureLoading.value = true
  try {
    const data = await api.documents.templates.structure(template.id)
    sheets.value = data.sheets
    activeSheet.value = mapping.value.sheet && data.sheets.some((s) => s.name === mapping.value.sheet) ? mapping.value.sheet! : (data.sheets[0]?.name ?? '')
    mapping.value.sheet = activeSheet.value
  } catch (error) { ElMessage.error((error as Error).message) } finally { structureLoading.value = false }
}

// 点格子：静态模式下选中该格等待绑定字段；明细模式下把该列绑定为明细字段
function pickCell(address: string) {
  selectedCell.value = address
  if (!itemMode.value) return
  const cell = currentSheet.value?.cells.find((c) => c.address === address)
  if (!cell) return
  if (!mapping.value.items) mapping.value.items = { startRow: 0, columns: {} }
  mapping.value.items.startRow = mapping.value.items.startRow || cell.row
  if (!pendingField.value) { ElMessage.info(`已设为明细行，请在右侧选择列字段`); return }
  mapping.value.items.columns = { ...(mapping.value.items.columns || {}), [String(cell.col)]: pendingField.value }
  pendingField.value = ''
}
function bindField() {
  if (!selectedCell.value || !pendingField.value) return ElMessage.warning('请先选择一个单元格和一个字段')
  mapping.value.cells = { ...(mapping.value.cells || {}), [selectedCell.value]: pendingField.value }
  pendingField.value = ''
}
// 追加模式：模板格子里已有标签文字，值接在后面而不是覆盖
function bindAppend() {
  if (!selectedCell.value || !pendingField.value) return ElMessage.warning('请先选择一个单元格和一个字段')
  mapping.value.cells = { ...(mapping.value.cells || {}), [selectedCell.value]: { field: pendingField.value, append: true } }
  pendingField.value = ''
}
// 块模式：一个格子里多行标签，按顺序依次对应多个字段（PI 的银行信息区块）
function bindBlock() {
  if (!selectedCell.value || !pendingField.value) return ElMessage.warning('请先选择单元格和第一个字段')
  const existing = mapping.value.cells?.[selectedCell.value]
  const list = existing && typeof existing === 'object' && existing.block ? [...existing.block] : []
  list.push(pendingField.value)
  mapping.value.cells = { ...(mapping.value.cells || {}), [selectedCell.value]: { block: list } }
  pendingField.value = ''
}
function unbind(address: string) {
  if (!mapping.value.cells) return
  const next = { ...mapping.value.cells }; delete next[address]; mapping.value.cells = next
}
function setItemStartRow(row: number) {
  if (!mapping.value.items) mapping.value.items = { startRow: 0, columns: {} }
  mapping.value.items.startRow = row
  ElMessage.success(`已设明细起始行为第 ${row} 行`)
}
async function saveMapping() {
  if (!editing.value) return
  try {
    await api.documents.templates.update(editing.value.id, { mapping: mapping.value })
    mappingVisible.value = false; await load(); ElMessage.success('字段映射已保存')
  } catch (error) { ElMessage.error((error as Error).message) }
}
async function removeTemplate(template: DocumentTemplate) {
  try { await ElMessageBox.confirm(`确定删除模板「${template.name}」吗？`, '删除确认', { type: 'warning' }); await api.documents.templates.remove(template.id); await load(); ElMessage.success('已删除') }
  catch (error) { if ((error as Error).message !== 'cancel') ElMessage.error((error as Error).message) }
}
function downloadTemplate(template: DocumentTemplate) { window.open(`/api/document-templates/${template.id}/file`, '_blank') }
function mappingCount(template: DocumentTemplate) {
  const cells = Object.keys(template.mapping?.cells || {}).length
  const columns = Object.keys(template.mapping?.items?.columns || {}).length
  return `静态 ${cells} 格 / 明细 ${columns} 列`
}

onMounted(async () => {
  try { [fieldGroups.value] = await Promise.all([api.documents.fields(), load()]) }
  catch (error) { ElMessage.error((error as Error).message) }
})
</script>
<template>
  <div class="page-view">
    <div class="page-heading">
      <div><h1>单证模板</h1><p>上传 .xlsx 模板后点格子绑定字段；生成单证时按映射自动填充并保留原版式</p></div>
      <el-button type="primary" :icon="Plus" @click="openUpload">上传模板</el-button>
    </div>

    <el-card class="content-card" shadow="never">
      <el-table :data="templates" empty-text="还没有模板，先上传一份 .xlsx">
        <el-table-column label="模板名称" min-width="180">
          <template #default="{ row }"><div class="name-cell"><el-icon><Document/></el-icon><span>{{ row.name }}</span></div></template>
        </el-table-column>
        <el-table-column prop="docType" label="类型" width="110"/>
        <el-table-column prop="fileName" label="原始文件" min-width="200"/>
        <el-table-column label="映射" width="170"><template #default="{ row }">{{ mappingCount(row) }}</template></el-table-column>
        <el-table-column prop="updatedAt" label="更新" width="120"/>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Edit" @click="openMapping(row)">配置映射</el-button>
            <el-button link :icon="Download" @click="downloadTemplate(row)">原文件</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeTemplate(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 上传模板 -->
    <el-dialog v-model="uploadVisible" title="上传单证模板" width="520px">
      <el-form label-width="90px">
        <el-form-item label="模板名称"><el-input v-model="uploadForm.name" placeholder="如：青田铭志 PI 模板"/></el-form-item>
        <el-form-item label="单证类型">
          <el-select v-model="uploadForm.docType" style="width:100%"><el-option v-for="t in DOC_TYPES" :key="t" :label="t" :value="t"/></el-select>
        </el-form-item>
        <el-form-item label="模板文件">
          <el-upload :auto-upload="false" :limit="1" accept=".xlsx" :on-change="onFileChange" :show-file-list="true">
            <el-button :icon="Upload">选择 .xlsx</el-button>
            <template #tip><div class="upload-tip">仅支持 .xlsx；旧版 .xls 请先在 Excel 里另存为 .xlsx</div></template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="uploadVisible=false">取消</el-button><el-button type="primary" @click="submitUpload">上传并配置</el-button></template>
    </el-dialog>

    <!-- 字段映射 -->
    <el-dialog v-model="mappingVisible" title="字段映射" width="min(1500px, 96vw)" top="3vh" :close-on-click-modal="false">
      <div v-loading="structureLoading" class="mapping-layout">
        <div class="mapping-main">
          <div class="mapping-toolbar">
            <el-select v-model="activeSheet" style="width:200px" @change="(name: string) => { mapping.sheet = name }">
              <el-option v-for="s in sheets" :key="s.name" :label="s.name" :value="s.name"/>
            </el-select>
            <el-switch v-model="itemMode" active-text="明细列模式" inactive-text="静态格模式"/>
            <span class="muted">{{ itemMode ? '点明细行的单元格 → 绑定为明细列' : '点单元格 → 在右侧选择字段绑定' }}</span>
            <el-tooltip content="把明细行的某个单元格绑定为「产品主图」，该列会按每行产品插入对应图片；绑定为「公司 Logo」则固定在静态格插图" placement="bottom">
              <el-tag size="small" type="info">支持插图</el-tag>
            </el-tooltip>
          </div>
          <div class="grid-scroll">
            <table class="sheet-grid">
              <tbody>
                <tr v-for="(row, rowIndex) in grid" :key="rowIndex">
                  <th class="row-head">{{ rowIndex + 1 }}</th>
                  <td v-for="cell in row" :key="cell.address" :rowspan="cell.rowSpan" :colspan="cell.colSpan"
                      :class="['sheet-cell', { selected: selectedCell === cell.address, bound: !!cellLabel(cell.address), 'item-row': itemColumnLabel(cell.address) }]"
                      v-show="!cell.hidden" @click="pickCell(cell.address)">
                    <div class="cell-address">{{ cell.address }}</div>
                    <div class="cell-text">{{ cell.text || '' }}</div>
                    <el-tag v-if="cellLabel(cell.address)" size="small" type="success" class="cell-tag">{{ cellLabel(cell.address) }}</el-tag>
                    <el-tag v-if="itemColumnLabel(cell.address)" size="small" type="warning" class="cell-tag">{{ itemColumnLabel(cell.address) }}</el-tag>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="mapping-side">
          <el-card shadow="never" class="side-card">
            <template #header><strong>当前单元格：{{ selectedCell || '未选择' }}</strong></template>
            <el-select v-model="pendingField" filterable placeholder="选择要绑定的字段" style="width:100%">
              <el-option-group v-for="group in fieldGroups" :key="group.group" :label="group.group">
                <el-option v-for="[value, label] in group.items" :key="value" :label="label" :value="value"/>
              </el-option-group>
            </el-select>
            <div class="bind-actions">
              <el-button size="small" type="primary" @click="bindField">覆盖绑定</el-button>
              <el-button size="small" @click="bindAppend">追加到标签后</el-button>
              <el-button size="small" @click="bindBlock">加入多行块</el-button>
            </div>
            <el-button v-if="selectedCell" size="small" type="danger" plain style="margin-top:8px;width:100%" @click="unbind(selectedCell)">解除 {{ selectedCell }} 绑定</el-button>
            <el-divider content-position="left">明细循环区</el-divider>
            <div class="muted">起始行：{{ mapping.items?.startRow || '未设置' }}</div>
            <el-button v-if="selectedCell" size="small" style="margin-top:8px;width:100%" @click="setItemStartRow(parseAddress(selectedCell)?.row || 0)">把选中行设为明细起始行</el-button>
          </el-card>
          <el-card shadow="never" class="side-card">
            <template #header><strong>已绑定</strong></template>
            <el-empty v-if="!Object.keys(mapping.cells || {}).length && !Object.keys(mapping.items?.columns || {}).length" description="暂无绑定" :image-size="60"/>
            <div v-for="(spec, address) in mapping.cells" :key="address" class="bound-row">
              <span class="bound-address">{{ address }}</span>
              <span class="bound-field">{{ fieldLabel(typeof spec === 'string' ? spec : (spec.field || (spec.block || []).filter(Boolean).join(' / '))) }}</span>
              <el-button link type="danger" size="small" @click="unbind(String(address))">移除</el-button>
            </div>
            <div v-for="(field, col) in mapping.items?.columns || {}" :key="`col-${col}`" class="bound-row">
              <span class="bound-address">{{ colLetter(Number(col)) }} 列</span>
              <span class="bound-field">{{ fieldLabel(String(field)) }}</span>
            </div>
          </el-card>
        </div>
      </div>
      <template #footer>
        <el-button @click="mappingVisible=false">取消</el-button>
        <el-button type="primary" @click="saveMapping">保存映射</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<style scoped>
.name-cell { display: flex; align-items: center; gap: 6px; }
.muted { color: #909399; font-size: 12px; }
.upload-tip { font-size: 12px; color: #909399; }
.mapping-layout { display: flex; gap: 16px; align-items: flex-start; }
.mapping-main { flex: 1 1 auto; min-width: 0; }
.mapping-side { flex: 0 0 320px; }
.mapping-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.grid-scroll { max-height: 62vh; overflow: auto; border: 1px solid #ebeef5; }
.sheet-grid { border-collapse: collapse; font-size: 11px; }
.row-head { position: sticky; left: 0; background: #f5f7fa; color: #909399; border: 1px solid #ebeef5; width: 32px; }
.sheet-cell { border: 1px solid #ebeef5; padding: 4px 6px; vertical-align: top; min-width: 110px; max-width: 220px; cursor: pointer; background: #fff; }
.sheet-cell:hover { background: #eef5ff; }
.sheet-cell.selected { outline: 2px solid #409eff; outline-offset: -2px; background: #e8f3ff; }
.sheet-cell.bound { background: #f0f9eb; }
.sheet-cell.item-row { background: #fdf6ec; }
.cell-address { color: #c0c4cc; font-size: 10px; }
.cell-text { white-space: pre-wrap; word-break: break-word; max-height: 60px; overflow: hidden; }
.cell-tag { margin-top: 4px; }
.side-card { margin-bottom: 12px; }
.bind-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.bound-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed #ebeef5; }
.bound-address { color: #409eff; width: 56px; flex: 0 0 56px; }
.bound-field { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
