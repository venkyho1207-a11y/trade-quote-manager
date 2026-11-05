<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { CopyDocument, Delete, Edit, Plus, Search, View, Box } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { api } from '../services/api'
import type { Product, Supplier } from '../types/domain'

const products = ref<Product[]>([])
const suppliers = ref<Supplier[]>([])
const keyword = ref('')
const dialogVisible = ref(false)
const inquiryVisible = ref(false)
const editingId = ref<string | null>(null)
const selected = ref<Product | null>(null)
const supplierDetailVisible = ref(false)
const currentSupplier = ref<Supplier | null>(null)
const formRef = ref<FormInstance>()
const form = reactive({ name: '', sku: '', model: '', cost: 0, image: '', specification: '', description: '', surfaceTreatment: '', moq: 0, packingQuantity: 0, packingRequirement: '', note: '', unit: 'PCS', hsCode: '', cartonGrossWeight: 0, cartonNetWeight: 0, cartonVolume: 0, cartonSize: '', supplierIds: [] as string[] })
const inquiry = reactive({ supplierId: '', quote: 0, inquiryDate: new Date().toISOString().slice(0, 10), note: '' })
const sortField = ref<'cost' | 'moq' | 'packingQuantity'>('cost')
const sortOrder = ref<'desc' | 'asc'>('desc')

const filtered = computed(() => {
  const list = products.value.filter((item) => `${item.name} ${item.sku} ${item.model} ${item.specification}`.toLowerCase().includes(keyword.value.toLowerCase()))
  // 按选定数值字段排序，从大到小(desc)或从小到大(asc)
  return [...list].sort((a, b) => sortOrder.value === 'desc' ? b[sortField.value] - a[sortField.value] : a[sortField.value] - b[sortField.value])
})
const emptyForm = () => Object.assign(form, { name: '', sku: '', model: '', cost: 0, image: '', specification: '', description: '', surfaceTreatment: '', moq: 0, packingQuantity: 0, packingRequirement: '', note: '', unit: 'PCS', hsCode: '', cartonGrossWeight: 0, cartonNetWeight: 0, cartonVolume: 0, cartonSize: '', supplierIds: [] as string[] })
async function load() { [products.value, suppliers.value] = await Promise.all([api.products.list(), api.suppliers.list()]) }
function openCreate() { editingId.value = null; emptyForm(); dialogVisible.value = true }
function openEdit(item: Product) { editingId.value = item.id; Object.assign(form, pickForm(item)); dialogVisible.value = true }
// 从产品对象里只取表单声明的字段，剔除 id/suppliers/createdAt/updatedAt，避免 strict 校验报错
function pickForm(item: Product) { return { name: item.name, sku: item.sku, model: item.model, cost: item.cost, image: item.image, specification: item.specification, description: item.description, surfaceTreatment: item.surfaceTreatment, moq: item.moq, packingQuantity: item.packingQuantity, packingRequirement: item.packingRequirement, note: item.note, unit: item.unit, hsCode: item.hsCode, cartonGrossWeight: item.cartonGrossWeight, cartonNetWeight: item.cartonNetWeight, cartonVolume: item.cartonVolume, cartonSize: item.cartonSize, supplierIds: [...item.supplierIds] } }
// 复制已有产品：复用 pickForm，SKU 唯一需清空让用户重填
function openCopy(item: Product) { editingId.value = null; Object.assign(form, pickForm(item), { sku: '' }); dialogVisible.value = true }
async function save() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try { if (editingId.value) await api.products.update(editingId.value, form); else await api.products.create(form); await load(); dialogVisible.value = false; ElMessage.success('产品已保存') } catch (error) { ElMessage.error((error as Error).message) }
}
async function remove(item: Product) { try { await ElMessageBox.confirm(`确定删除“${item.name}”吗？`, '删除确认', { type: 'warning' }); await api.products.remove(item.id); await load(); ElMessage.success('已删除') } catch (error) { if ((error as Error).message !== 'cancel') ElMessage.error((error as Error).message) } }
function showInquiry(item: Product) { selected.value = item; Object.assign(inquiry, { supplierId: '', quote: item.cost, inquiryDate: new Date().toISOString().slice(0, 10), note: '' }); inquiryVisible.value = true }
async function saveInquiry() { if (!selected.value || !inquiry.supplierId || inquiry.quote <= 0) return ElMessage.warning('请选择供应商并填写正数报价'); try { await api.products.addInquiry(selected.value.id, inquiry); await load(); selected.value = products.value.find((item) => item.id === selected.value?.id) ?? null; ElMessage.success('询价记录已保存') } catch (error) { ElMessage.error((error as Error).message) } }
async function uploadImage(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) return ElMessage.error('仅支持5MB以内 JPG、PNG、WebP 图片'); const body = new FormData(); body.append('image', file); const response = await fetch('/api/uploads', { method: 'POST', body, credentials: 'same-origin' }); form.image = (await response.json()).url }
// 点击供应商名称，弹出该供应商的完整信息
function showSupplierDetail(supplierId: string) { currentSupplier.value = suppliers.value.find((s) => s.id === supplierId) ?? null; if (currentSupplier.value) supplierDetailVisible.value = true }
onMounted(() => load().catch((error) => ElMessage.error(error.message)))
</script>

<template>
  <div class="page-view">
    <div class="page-heading"><div><h1>产品库</h1><p>维护产品基础资料、供应商报价及历史询价记录</p></div><el-button type="primary" :icon="Plus" @click="openCreate">新增产品</el-button></div>
    <el-card class="content-card" shadow="never">
      <div class="filter-bar"><el-input v-model="keyword" clearable :prefix-icon="Search" placeholder="搜索产品名称、SKU、型号或规格" /><el-select v-model="sortField" style="width: 150px"><el-option label="按成本排序" value="cost" /><el-option label="按MOQ排序" value="moq" /><el-option label="按装箱数排序" value="packingQuantity" /></el-select><el-select v-model="sortOrder" style="width: 130px"><el-option label="从大到小" value="desc" /><el-option label="从小到大" value="asc" /></el-select><el-button :icon="Plus" type="primary" plain @click="openCreate">新增产品</el-button></div>
      <el-table :data="filtered" row-key="id" class="product-table">
        <el-table-column label="产品名称" min-width="280"><template #default="{ row }"><div class="product-cell"><div class="product-thumb"><img v-if="row.image" :src="row.image" :alt="row.name"><el-icon v-else><Box /></el-icon></div><div class="product-copy"><strong>{{ row.name }}</strong><span>{{ row.specification }}</span></div></div></template></el-table-column>
        <el-table-column prop="model" label="型号" width="140" /><el-table-column prop="sku" label="SKU" width="170" />
        <el-table-column label="单个成本" width="120"><template #default="{ row }">¥{{ row.cost.toFixed(2) }}</template></el-table-column>
        <el-table-column prop="moq" label="MOQ" width="90" />
        <el-table-column label="供应商" min-width="180"><template #default="{ row }"><template v-if="row.supplierIds.length"><el-button v-for="id in row.supplierIds" :key="id" link type="primary" @click="showSupplierDetail(id)">{{ suppliers.find((s) => s.id === id)?.name ?? id }}</el-button></template><span v-else>—</span></template></el-table-column>
        <el-table-column label="供应商/询价" min-width="190"><template #default="{ row }">{{ row.suppliers.length }} 条记录<small class="block-muted">{{ row.suppliers.map((item: Product['suppliers'][number]) => item.supplierName).join('、') || '暂未询价' }}</small></template></el-table-column>
        <el-table-column prop="updatedAt" label="最近更新" width="130" /><el-table-column label="操作" width="270" fixed="right"><template #default="{ row }"><el-button link type="primary" :icon="View" @click="showInquiry(row)">询价</el-button><el-button link :icon="CopyDocument" @click="openCopy(row)">复制</el-button><el-button link :icon="Edit" @click="openEdit(row)">编辑</el-button><el-button link type="danger" :icon="Delete" @click="remove(row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑产品' : '新增产品'" width="720px"><el-form ref="formRef" :model="form" label-width="100px" :rules="{ name: [{ required: true, message: '请输入产品名称' }], sku: [{ required: true, message: '请输入SKU' }], model: [{ required: true, message: '请输入型号' }], cost: [{ type: 'number', min: 0.01, message: '成本必须大于0' }], specification: [{ required: true, message: '请输入规格' }] }">
      <el-row :gutter="18"><el-col :span="14"><el-form-item label="产品名称" prop="name"><el-input v-model="form.name" /></el-form-item></el-col><el-col :span="10"><el-form-item label="型号" prop="model"><el-input v-model="form.model" /></el-form-item></el-col></el-row>
      <el-row :gutter="18"><el-col :span="10"><el-form-item label="SKU" prop="sku"><el-input v-model="form.sku" /></el-form-item></el-col><el-col :span="8"><el-form-item label="单个成本" prop="cost"><el-input-number v-model="form.cost" :min="0.01" :precision="2" /></el-form-item></el-col><el-col :span="6"><el-form-item label="表面处理"><el-input v-model="form.surfaceTreatment" /></el-form-item></el-col></el-row>
      <el-form-item label="规格" prop="specification"><el-input v-model="form.specification" /></el-form-item>
      <el-form-item label="产品描述"><el-input v-model="form.description" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="供应商"><el-select v-model="form.supplierIds" multiple class="full-width" placeholder="选择供货供应商"><el-option v-for="item in suppliers" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
      <el-row :gutter="18"><el-col :span="8"><el-form-item label="MOQ"><el-input-number v-model="form.moq" :min="0" :precision="0" /></el-form-item></el-col><el-col :span="8"><el-form-item label="装箱数"><el-input-number v-model="form.packingQuantity" :min="0" :precision="0" /></el-form-item></el-col><el-col :span="8"><el-form-item label="包装要求"><el-input v-model="form.packingRequirement" /></el-form-item></el-col></el-row>
      <!-- 单证参数：P1 存储单箱口径，生成单证时按 总数量÷装箱数 自动累加成整单数据 -->
      <el-divider content-position="left">单证参数（PI / 发票 / 装箱单使用）</el-divider>
      <el-row :gutter="18"><el-col :span="8"><el-form-item label="单位"><el-input v-model="form.unit" placeholder="PCS / 件 / 个" /></el-form-item></el-col><el-col :span="16"><el-form-item label="HS 商品编号"><el-input v-model="form.hsCode" placeholder="如 4202.92.00" /></el-form-item></el-col></el-row>
      <el-row :gutter="18"><el-col :span="8"><el-form-item label="单箱毛重 KG"><el-input-number v-model="form.cartonGrossWeight" :min="0" :precision="2" class="full-width" controls-position="right" /></el-form-item></el-col><el-col :span="8"><el-form-item label="单箱净重 KG"><el-input-number v-model="form.cartonNetWeight" :min="0" :precision="2" class="full-width" controls-position="right" /></el-form-item></el-col><el-col :span="8"><el-form-item label="单箱体积 CBM"><el-input-number v-model="form.cartonVolume" :min="0" :precision="3" class="full-width" controls-position="right" /></el-form-item></el-col></el-row>
      <el-form-item label="外箱尺寸"><el-input v-model="form.cartonSize" placeholder="如 50*40*30 cm" /></el-form-item>
      <div class="form-hint">总箱数 = 订单数量 ÷ 装箱数（向上取整）；总毛重 = 总箱数 × 单箱毛重。弹窗里可临时覆盖。</div>
      <el-form-item label="产品图片"><input type="file" accept="image/jpeg,image/png,image/webp" @change="uploadImage"><img v-if="form.image" class="form-image" :src="form.image" alt="产品图片"></el-form-item>
      <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="3" /></el-form-item>
    </el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template></el-dialog>
    <el-dialog v-model="inquiryVisible" :title="`${selected?.name ?? ''} · 询价记录`" width="760px"><el-form inline><el-form-item label="供应商"><el-select v-model="inquiry.supplierId" placeholder="请选择"><el-option v-for="item in suppliers" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="报价"><el-input-number v-model="inquiry.quote" :min="0.01" :precision="2" /></el-form-item><el-form-item label="日期"><el-date-picker v-model="inquiry.inquiryDate" value-format="YYYY-MM-DD" /></el-form-item><el-button type="primary" @click="saveInquiry">新增询价</el-button></el-form><el-table :data="selected?.suppliers ?? []" border><el-table-column prop="supplierName" label="供应商" /><el-table-column prop="contact" label="联系人" /><el-table-column prop="quote" label="报价" /><el-table-column prop="inquiryDate" label="日期" /><el-table-column prop="note" label="备注" /></el-table></el-dialog>

    <el-dialog v-model="supplierDetailVisible" :title="`供应商信息`" width="520px"><template v-if="currentSupplier"><el-descriptions :column="1" border><el-descriptions-item label="供应商名称">{{ currentSupplier.name }}</el-descriptions-item><el-descriptions-item label="联系人">{{ currentSupplier.contact }}</el-descriptions-item><el-descriptions-item label="职位">{{ currentSupplier.position || '—' }}</el-descriptions-item><el-descriptions-item label="联系方式">{{ currentSupplier.whatsapp || '—' }}</el-descriptions-item><el-descriptions-item label="联系号码">{{ currentSupplier.phone || '—' }}</el-descriptions-item><el-descriptions-item label="邮箱">{{ currentSupplier.email || '—' }}</el-descriptions-item><el-descriptions-item label="地址">{{ currentSupplier.address || '—' }}</el-descriptions-item><el-descriptions-item label="备注">{{ currentSupplier.note || '—' }}</el-descriptions-item></el-descriptions></template><template #footer><el-button type="primary" @click="supplierDetailVisible = false">关闭</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.form-hint { font-size: 12px; color: #909399; line-height: 1.5; margin: -6px 0 12px 100px; }
</style>
