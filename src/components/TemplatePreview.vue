<script setup lang="ts">
import { computed } from 'vue'

// 只负责把后端返回的二维表格 + 合并区域画成表格，单证中心和生成单证页共用
interface PreviewRow { row: number; cells: string[] }
interface MergeBox { top: number; left: number; rowSpan: number; colSpan: number }
const props = defineProps<{ rows: PreviewRow[]; merges: string[]; columnCount: number; imageCount?: number }>()

function parseRef(address: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(address).replace(/\$/g, '').toUpperCase())
  if (!match) return null
  let col = 0; for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]), col }
}
// 合并区域换算成 rowspan/colspan，被覆盖的格子不再渲染，避免版面错位
const mergeMap = computed(() => {
  const starts = new Map<string, MergeBox>(); const covered = new Set<string>()
  for (const range of props.merges) {
    const [start, end = start] = range.split(':')
    const s = parseRef(start); const e = parseRef(end)
    if (!s || !e) continue
    starts.set(`${s.row}:${s.col}`, { top: s.row, left: s.col, rowSpan: e.row - s.row + 1, colSpan: e.col - s.col + 1 })
    for (let r = s.row; r <= e.row; r += 1) for (let c = s.col; c <= e.col; c += 1) {
      if (r !== s.row || c !== s.col) covered.add(`${r}:${c}`)
    }
  }
  return { starts, covered }
})
// 按列号对齐：cells 数组下标 0 对应第 1 列
function spanFor(row: number, index: number) { return mergeMap.value.starts.get(`${row}:${index + 1}`) }
function isCovered(row: number, index: number) { return mergeMap.value.covered.has(`${row}:${index + 1}`) }
</script>
<template>
  <div class="preview-wrap">
    <!-- 文本预览呈现不了图片，明确告知，免得出错时以为图没插进去 -->
    <div v-if="imageCount" class="preview-image-hint">该单证含 {{ imageCount }} 张图片（产品图 / Logo），预览仅显示文字，图片需下载 Excel 查看</div>
    <div class="template-preview-scroll">
      <table class="template-preview">
        <tbody>
          <tr v-for="row in rows" :key="row.row">
            <th class="preview-rowno">{{ row.row }}</th>
            <template v-for="(text, index) in row.cells" :key="index">
              <td v-if="!isCovered(row.row, index)"
                  :rowspan="spanFor(row.row, index)?.rowSpan"
                  :colspan="spanFor(row.row, index)?.colSpan">{{ text }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.preview-image-hint { font-size: 12px; color: #e6a23c; background: #fdf6ec; border: 1px solid #faecd8; border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; }
.template-preview-scroll { overflow: auto; border: 1px solid #ebeef5; background: #fff; }
.template-preview { border-collapse: collapse; font-size: 12px; width: 100%; table-layout: fixed; }
.template-preview td { border: 1px solid #ebeef5; padding: 4px 8px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
.preview-rowno { position: sticky; left: 0; width: 34px; background: #f5f7fa; color: #909399; border: 1px solid #ebeef5; font-weight: normal; font-size: 11px; }
</style>
