<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Delete, Plus, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../services/api'
import type { Customer, CustomerFollowUp, CustomerType } from '../types/domain'

const props = defineProps<{ initialCustomerId?: string | null }>()

const rows = ref<Customer[]>([]); const keyword = ref('')
const selectedId = ref<string | null>(null)
const followUps = ref<CustomerFollowUp[]>([])

const TYPE_OPTIONS: { label: string; value: CustomerType; cycle: string }[] = [
  { label: '新客户', value: '新客户', cycle: '1/3/7/14/30 天节点' },
  { label: '订单客户', value: '订单客户', cycle: '30 天' },
  { label: '样单客户', value: '样单客户', cycle: '60 天' },
  { label: '重潜在客户', value: '重潜在客户', cycle: '90 天' },
  { label: '轻潜在客户', value: '轻潜在客户', cycle: '120 天' },
]

function typeTag(type: CustomerType) { return ({ '订单客户': 'success', '样单客户': 'warning', '重潜在客户': 'danger', '轻潜在客户': 'info', '新客户': 'primary' } as const)[type] }
function stageText(customer: Customer) { if (customer.type !== '新客户') return ''; const stages = [1, 3, 7, 14, 30]; const s = customer.followupStage || 0; return s >= stages.length ? '已走完节点，待转正' : `第 ${s + 1} 次跟进（+${stages[s]} 天）` }
function daysLeftText(customer: Customer) { if (customer.daysLeft === null) return '—'; if (customer.daysLeft < 0) return `已逾期 ${-customer.daysLeft} 天`; if (customer.daysLeft === 0) return '今天'; return `${customer.daysLeft} 天` }
function rowClass({ row }: { row: Customer }) { const d = row.daysLeft; if (d === null) return ''; if (d < 0) return 'row-overdue'; if (d === 0) return 'row-due-today'; if (d <= 3) return 'row-due-soon'; return '' }

// 解析时区偏移，依据中国时间（UTC+8）推算客户本地时间
function offsetHours(timezone: string): number | null { const m = /^UTC([+-]\d{1,2})$/.exec(timezone.trim()); return m ? Number(m[1]) : null }
const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = new Date() }, 60000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
function localTimeText(timezone: string): string { const offset = offsetHours(timezone); if (offset === null) return ''; const local = new Date(now.value.getTime() + (offset - 8) * 3600000); const p = (n: number) => String(n).padStart(2, '0'); return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}` }

// 按剩余时长升序：逾期最久在前，其次今日，再临近，无下次跟进日期的排最后
const filteredRows = computed(() => {
  const kw = keyword.value.toLowerCase()
  const list = rows.value.filter((row) => `${row.name} ${row.code} ${row.country} ${row.contact} ${row.email} ${row.salesperson}`.toLowerCase().includes(kw))
  return [...list].sort((a, b) => { const ad = a.daysLeft === null ? Number.POSITIVE_INFINITY : a.daysLeft; const bd = b.daysLeft === null ? Number.POSITIVE_INFINITY : b.daysLeft; return ad - bd })
})
const selected = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null)

async function load() { rows.value = await api.customers.list() }
async function loadFollowUps(id: string) { followUps.value = await api.customers.followUps(id) }
function select(row: Customer) { selectedId.value = row.id; followForm.followedAt = today(); followForm.content = ''; loadFollowUps(row.id) }

// 新增跟进：内联表单，避免嵌套弹窗
const followForm = reactive({ followedAt: '', content: '' })
function today() { return new Date().toISOString().slice(0, 10) }
async function saveFollowUp() { if (!selected.value) return; if (!followForm.followedAt || !followForm.content.trim()) return ElMessage.warning('跟进日期和内容不能为空'); try { const { customer } = await api.customers.addFollowUp(selected.value.id, { followedAt: followForm.followedAt, content: followForm.content.trim() }); const index = rows.value.findIndex((row) => row.id === customer.id); if (index >= 0) rows.value[index] = customer; followForm.content = ''; await loadFollowUps(customer.id); ElMessage.success('跟进已记录') } catch (error) { ElMessage.error((error as Error).message) } }

// 删除跟进记录：删除后重新加载时间轴，并同步该客户的最新跟进/下次跟进日期
async function removeFollowUp(item: CustomerFollowUp) { if (!selected.value) return; try { await ElMessageBox.confirm(`确定删除 ${item.followedAt} 的这条跟进记录吗？`, '删除确认', { type: 'warning' }); const { customer } = await api.customers.removeFollowUp(selected.value.id, item.id); const index = rows.value.findIndex((row) => row.id === customer.id); if (index >= 0) rows.value[index] = customer; await loadFollowUps(customer.id); ElMessage.success('已删除') } catch (error) { if ((error as Error).message !== 'cancel') ElMessage.error((error as Error).message) } }

onMounted(async () => { await load().catch((error) => ElMessage.error(error.message)); if (props.initialCustomerId && rows.value.some((row) => row.id === props.initialCustomerId)) { selectedId.value = props.initialCustomerId; await loadFollowUps(props.initialCustomerId) } })
</script>

<template>
  <div class="page-view">
    <div class="page-heading">
      <div><h1>客户跟进</h1><p>按到期时间排序，逾期优先；点击客户在右侧录入跟进内容</p></div>
    </div>
    <div class="followup-layout">
      <el-card class="content-card followup-list" shadow="never">
        <div class="filter-bar"><el-input v-model="keyword" clearable :prefix-icon="Search" placeholder="搜索客户"/></div>
        <el-table :data="filteredRows" :row-class-name="rowClass" highlight-current-row @current-change="(row: Customer | null) => row && select(row)">
          <el-table-column prop="code" label="代码" width="110"/>
          <el-table-column prop="name" label="客户名称" min-width="150"/>
          <el-table-column label="类型" width="100"><template #default="{ row }"><el-tag :type="typeTag(row.type)" size="small">{{ row.type }}</el-tag></template></el-table-column>
          <el-table-column label="本地时间" width="135"><template #default="{ row }">{{ localTimeText(row.timezone) || '—' }}</template></el-table-column>
          <el-table-column label="最近跟进" width="105"><template #default="{ row }">{{ row.lastFollowUpAt || '—' }}</template></el-table-column>
          <el-table-column label="下次跟进" width="105"><template #default="{ row }">{{ row.nextFollowUpAt || '—' }}</template></el-table-column>
          <el-table-column label="剩余" width="120"><template #default="{ row }"><span :class="{ 'overdue': row.daysLeft !== null && row.daysLeft < 0 }">{{ daysLeftText(row) }}</span></template></el-table-column>
          <el-table-column prop="salesperson" label="业务员" width="90"/>
        </el-table>
      </el-card>

      <el-card class="content-card followup-detail" shadow="never">
        <template v-if="selected">
          <div class="detail-head">
            <div>
              <div class="detail-title">{{ selected.name }} <el-tag :type="typeTag(selected.type)" size="small">{{ selected.type }}</el-tag></div>
              <div class="detail-sub">{{ selected.country }} · {{ selected.contact }} · {{ selected.email || '无邮箱' }}</div>
              <div class="detail-sub">下次跟进：{{ selected.nextFollowUpAt || '—' }}（{{ daysLeftText(selected) }}）{{ stageText(selected) ? ' · ' + stageText(selected) : '' }}</div>
            </div>
          </div>

          <div class="add-followup">
            <el-form label-width="72px">
              <el-form-item label="跟进日期"><el-date-picker v-model="followForm.followedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%"/></el-form-item>
              <el-form-item label="跟进内容"><el-input v-model="followForm.content" type="textarea" :rows="3" placeholder="记录本次跟进内容"/></el-form-item>
              <el-form-item><el-button type="primary" :icon="Plus" @click="saveFollowUp">保存跟进</el-button></el-form-item>
            </el-form>
          </div>

          <el-divider content-position="left">跟进时间轴</el-divider>
          <el-empty v-if="!followUps.length" description="暂无跟进记录" :image-size="60"/>
          <el-timeline v-else>
            <el-timeline-item v-for="item in followUps" :key="item.id" :timestamp="item.followedAt" placement="top">
              <el-card shadow="never">
                <div class="followup-item">
                  <div class="followup-content">{{ item.content }}</div>
                  <el-button link type="danger" :icon="Delete" @click="removeFollowUp(item)">删除</el-button>
                </div>
              </el-card>
            </el-timeline-item>
          </el-timeline>
        </template>
        <el-empty v-else description="请在左侧选择一个客户" class="detail-empty"/>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.followup-layout { display: flex; gap: 16px; align-items: stretch; }
.followup-list { flex: 1 1 58%; min-width: 0; }
.followup-detail { flex: 1 1 42%; min-width: 0; }
.detail-head { margin-bottom: 12px; }
.detail-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.detail-sub { color: #909399; font-size: 13px; margin-top: 4px; line-height: 1.5; }
.add-followup { background: #f7f8fa; border-radius: 6px; padding: 14px 14px 2px; margin-bottom: 4px; }
.followup-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.followup-content { flex: 1; white-space: pre-wrap; word-break: break-word; }
.overdue { color: #f56c6c; font-weight: 600; }
.detail-empty { margin-top: 60px; }
:deep(.row-overdue) { --el-table-tr-bg-color: #fde2e2; }
:deep(.row-overdue:hover > td) { background-color: #fbd2d2 !important; }
:deep(.row-due-today) { --el-table-tr-bg-color: #fdf3e0; }
:deep(.row-due-today:hover > td) { background-color: #fbe9c8 !important; }
:deep(.row-due-soon) { --el-table-tr-bg-color: #fdf6df; }
:deep(.row-due-soon:hover > td) { background-color: #fbefcd !important; }
</style>
