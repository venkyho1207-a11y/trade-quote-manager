<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Search, Clock } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../services/api'
import type { Customer, CustomerType } from '../types/domain'

// 「跟进」跳转到独立跟进页：把目标客户 id 交给 App 处理
const emit = defineEmits<{ (e: 'followup', id: string): void }>()

const rows = ref<Customer[]>([]); const keyword = ref(''); const visible = ref(false); const editingId = ref<string | null>(null)

// 客户类型 → 跟进间隔，供表单提示；后端以同一映射为准
const TYPE_OPTIONS: { label: string; value: CustomerType; cycle: string }[] = [
  { label: '新客户', value: '新客户', cycle: '1/3/7/14/30 天节点' },
  { label: '订单客户', value: '订单客户', cycle: '30 天' },
  { label: '样单客户', value: '样单客户', cycle: '60 天' },
  { label: '重潜在客户', value: '重潜在客户', cycle: '90 天' },
  { label: '轻潜在客户', value: '轻潜在客户', cycle: '120 天' },
]
const TIMEZONES = ['UTC-12', 'UTC-11', 'UTC-10', 'UTC-9', 'UTC-8', 'UTC-7', 'UTC-6', 'UTC-5', 'UTC-4', 'UTC-3', 'UTC-2', 'UTC-1', 'UTC+0', 'UTC+1', 'UTC+2', 'UTC+3', 'UTC+4', 'UTC+5', 'UTC+6', 'UTC+7', 'UTC+8', 'UTC+9', 'UTC+10', 'UTC+11', 'UTC+12', 'UTC+13', 'UTC+14']

// 解析 "UTC+8" / "UTC-5" 得到小时偏移；无法识别时返回 null
function offsetHours(timezone: string): number | null {
  const match = /^UTC([+-]\d{1,2})$/.exec(timezone.trim())
  if (!match) return null
  return Number(match[1])
}

// 依据中国时间（UTC+8）推算客户本地时间，实时刷新
const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = new Date() }, 60000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

// 客户本地时间（含时分），无时区或格式非法时返回空
function localTimeText(timezone: string): string {
  const offset = offsetHours(timezone)
  if (offset === null) return ''
  const local = new Date(now.value.getTime() + (offset - 8) * 3600000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}
function localTimeTextForForm(): string { const t = localTimeText(form.timezone); return t ? `客户本地时间：${t}` : '' }

const emptyForm = { code: '', name: '', type: '新客户' as CustomerType, country: '', timezone: '', business: '', website: '', contact: '', phone: '', address: '', email: '', zip: '', fax: '', salesperson: '', note: '' }
const form = reactive({ ...emptyForm })
const reset = () => Object.assign(form, emptyForm)

async function load() { rows.value = await api.customers.list() }
function create() { editingId.value = null; reset(); visible.value = true }
function edit(row: Customer) { editingId.value = row.id; Object.assign(form, { code: row.code, name: row.name, type: row.type, country: row.country, timezone: row.timezone, business: row.business, website: row.website, contact: row.contact, phone: row.phone, address: row.address, email: row.email, zip: row.zip, fax: row.fax, salesperson: row.salesperson, note: row.note }); visible.value = true }
async function save() { if (!form.name || !form.country || !form.contact) return ElMessage.warning('客户名称、国家和联系人不能为空'); try { if (editingId.value) await api.customers.update(editingId.value, form); else await api.customers.create(form); await load(); visible.value = false; ElMessage.success('客户已保存') } catch (error) { ElMessage.error((error as Error).message) } }
async function remove(row: Customer) { try { await ElMessageBox.confirm(`确定删除“${row.name}”吗？`, '删除确认', { type: 'warning' }); await api.customers.remove(row.id); await load(); ElMessage.success('已删除') } catch (error) { if ((error as Error).message !== 'cancel') ElMessage.error((error as Error).message) } }
function goFollowup(row: Customer) { emit('followup', row.id) }

function typeTag(type: CustomerType) { return ({ '订单客户': 'success', '样单客户': 'warning', '重潜在客户': 'danger', '轻潜在客户': 'info', '新客户': 'primary' } as const)[type] }
function stageText(customer: Customer) { if (customer.type !== '新客户') return ''; const stages = [1, 3, 7, 14, 30]; const s = customer.followupStage || 0; return s >= stages.length ? '已走完节点，待转正' : `第 ${s + 1} 次跟进（+${stages[s]} 天）` }
function daysLeftText(customer: Customer) { if (customer.daysLeft === null) return '—'; if (customer.daysLeft < 0) return `已逾期 ${-customer.daysLeft} 天`; if (customer.daysLeft === 0) return '今天'; return `${customer.daysLeft} 天` }
// 到期提醒：逾期（红）、今日（橙）、3天内临近（黄）分别高亮整行
function rowClass({ row }: { row: Customer }) {
  const d = row.daysLeft
  if (d === null) return ''
  if (d < 0) return 'row-overdue'
  if (d === 0) return 'row-due-today'
  if (d <= 3) return 'row-due-soon'
  return ''
}

// 类型列排序：按业务重要度（订单>样单>重潜在>轻潜在>新客户）而非拼音/字符串
const TYPE_ORDER: Record<CustomerType, number> = { '订单客户': 5, '样单客户': 4, '重潜在客户': 3, '轻潜在客户': 2, '新客户': 1 }
function typeSorter(a: Customer, b: Customer) { return (TYPE_ORDER[a.type] ?? 0) - (TYPE_ORDER[b.type] ?? 0) }
// 剩余时长列排序：无下次跟进日期的排最后，其余按天数升序
function daysLeftSorter(a: Customer, b: Customer) { const ad = a.daysLeft === null ? Number.POSITIVE_INFINITY : a.daysLeft; const bd = b.daysLeft === null ? Number.POSITIVE_INFINITY : b.daysLeft; return ad - bd }
// 本地时间列排序：按 UTC 偏移升序
function timezoneSorter(a: Customer, b: Customer) { const ao = offsetHours(a.timezone); const bo = offsetHours(b.timezone); if (ao === null && bo === null) return 0; if (ao === null) return 1; if (bo === null) return -1; return ao - bo }

onMounted(() => load().catch((error) => ElMessage.error(error.message)))
</script>
<template>
  <div class="page-view">
    <div class="page-heading">
      <div><h1>客户档案</h1><p>维护客户基础资料，记录跟进时间轴；新建报价单时自动带出客户信息</p></div>
      <el-button type="primary" :icon="Plus" @click="create">新增客户</el-button>
    </div>
    <el-card class="content-card" shadow="never">
      <div class="filter-bar">
        <el-input v-model="keyword" clearable :prefix-icon="Search" placeholder="搜索客户名称、代码、国家、联系人或邮箱"/>
      </div>
      <el-table :data="rows.filter((row) => `${row.name} ${row.code} ${row.country} ${row.contact} ${row.email} ${row.salesperson}`.toLowerCase().includes(keyword.toLowerCase()))" :row-class-name="rowClass">
        <el-table-column prop="code" label="客户代码" width="120" sortable/>
        <el-table-column prop="name" label="客户名称" min-width="170" sortable/>
        <el-table-column label="类型" width="110" :sortable="'custom'" :sort-method="typeSorter">
          <template #default="{ row }"><el-tag :type="typeTag(row.type)" size="small">{{ row.type }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="country" label="国家" width="110" sortable/>
        <el-table-column label="本地时间" width="140" :sortable="'custom'" :sort-method="timezoneSorter"><template #default="{ row }">{{ localTimeText(row.timezone) || '—' }}</template></el-table-column>
        <el-table-column prop="contact" label="联系人" width="130" sortable/>
        <el-table-column prop="email" label="联系邮箱" min-width="190" sortable/>
        <el-table-column prop="salesperson" label="跟进业务员" width="110" sortable/>
        <el-table-column prop="lastFollowUpAt" label="最近跟进" width="110" sortable><template #default="{ row }">{{ row.lastFollowUpAt || '—' }}</template></el-table-column>
        <el-table-column prop="nextFollowUpAt" label="下次跟进" width="110" sortable><template #default="{ row }">{{ row.nextFollowUpAt || '—' }}</template></el-table-column>
        <el-table-column label="剩余时长" width="120" :sortable="'custom'" :sort-method="daysLeftSorter"><template #default="{ row }"><span :class="{ 'overdue': row.daysLeft !== null && row.daysLeft < 0 }">{{ daysLeftText(row) }}</span></template></el-table-column>
        <el-table-column prop="createdAt" label="创建日期" width="110" sortable><template #default="{ row }">{{ row.createdAt }}</template></el-table-column>
        <el-table-column label="跟进进度" min-width="150"><template #default="{ row }">{{ stageText(row) }}</template></el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link :icon="Clock" @click="goFollowup(row)">跟进</el-button>
            <el-button link :icon="Edit" @click="edit(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增 / 编辑客户 -->
    <el-dialog v-model="visible" :title="editingId ? '编辑客户' : '新增客户'" width="760px">
      <el-form label-width="100px">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="客户代码"><el-input v-model="form.code" placeholder="如 CUS-001，留空则自动跳过"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="客户名称"><el-input v-model="form.name"/></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="客户类型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="t in TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value"/>
              </el-select>
              <div class="form-hint">周期：{{ TYPE_OPTIONS.find((t) => t.value === form.type)?.cycle }}</div>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="国家"><el-input v-model="form.country"/></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="时区">
              <el-select v-model="form.timezone" filterable allow-create style="width: 100%" placeholder="选择或输入时区">
                <el-option v-for="tz in TIMEZONES" :key="tz" :label="tz" :value="tz"/>
              </el-select>
              <div class="form-hint">{{ localTimeTextForForm() || '选择后按中国时间（UTC+8）推算客户本地时间' }}</div>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="主营业务"><el-input v-model="form.business"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="公司网站"><el-input v-model="form.website"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="联系方式"><el-input v-model="form.contact" placeholder="联系人姓名"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="联系号码"><el-input v-model="form.phone"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="联系邮箱"><el-input v-model="form.email"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="跟进业务员"><el-input v-model="form.salesperson"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="邮编"><el-input v-model="form.zip" placeholder="单证 Buyer 栏位使用"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="传真"><el-input v-model="form.fax"/></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="联系地址"><el-input v-model="form.address"/></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="form.note" type="textarea"/></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<style scoped>
.form-hint { font-size: 12px; color: #909399; line-height: 1.4; }
.overdue { color: #f56c6c; font-weight: 600; }
/* 到期提醒：el-table 行高亮需用 :deep 穿透，覆盖到整行单元格 */
:deep(.row-overdue) { --el-table-tr-bg-color: #fde2e2; }
:deep(.row-overdue:hover > td) { background-color: #fbd2d2 !important; }
:deep(.row-due-today) { --el-table-tr-bg-color: #fdf3e0; }
:deep(.row-due-today:hover > td) { background-color: #fbe9c8 !important; }
:deep(.row-due-soon) { --el-table-tr-bg-color: #fdf6df; }
:deep(.row-due-soon:hover > td) { background-color: #fbefcd !important; }
</style>
