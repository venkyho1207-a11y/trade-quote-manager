export interface QuoteCalculationInput {
  quantity: number
  cost: number
  packagingFee: number
  profit: number
  domesticFreight: number
  customsFee: number
  bankFee: number
  oceanFreight: number
  insuranceFee: number
}

export interface QuoteCalculationResult {
  exw: number
  fob: number
  cif: number
}

export function calculateRecommendedPrices(input: QuoteCalculationInput): QuoteCalculationResult {
  const sharedPerUnit = (input.domesticFreight + input.customsFee + input.bankFee + input.oceanFreight + input.insuranceFee) / input.quantity
  const base = input.cost + input.packagingFee + input.profit
  return {
    exw: roundMoney(base + input.domesticFreight / input.quantity),
    fob: roundMoney(base + (input.domesticFreight + input.customsFee + input.bankFee) / input.quantity),
    cif: roundMoney(base + sharedPerUnit),
  }
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function distributeRemainder(total: number, unitPrices: number[], quantities: number[]) {
  const targetCents = Math.round(total * 100)
  const values = unitPrices.map((unitPrice, index) => Math.round(unitPrice * quantities[index] * 100))
  const remainder = targetCents - values.reduce((sum, value) => sum + value, 0)
  if (values.length) values[values.length - 1] += remainder
  return values.map((value) => value / 100)
}
