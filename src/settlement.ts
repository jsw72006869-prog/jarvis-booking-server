// settlement.ts - 정산서 + 발주서 자동 생성 모듈
// 밤(로젠택배) / 옥수수(롯데택배) 양식 분리
import * as XLSX from 'xlsx';

// ─── 상품별 원가 데이터 ───
interface ProductCost {
  name: string;
  cost: number;    // 제품원가
  price: number;   // 판매가
  shipping: number; // 배송비
}

// 밤 12종
const BAM_PRODUCTS: ProductCost[] = [
  { name: '공주알밤 대(1kg)',          cost: 8000,  price: 13800, shipping: 3000 },
  { name: '공주알밤 대(2kg)이상',       cost: 14000, price: 24800, shipping: 3000 },
  { name: '공주알밤 특(1kg)',          cost: 10000, price: 16800, shipping: 3000 },
  { name: '공주알밤 특(2kg)이상',       cost: 17000, price: 27800, shipping: 3000 },
  { name: '포르단칼집밤 대(1kg)',       cost: 11000, price: 19800, shipping: 3000 },
  { name: '포르단칼집밤 대(2kg)이상',   cost: 20000, price: 30800, shipping: 3000 },
  { name: '포르단칼집밤 특(1kg)',       cost: 12000, price: 22800, shipping: 3000 },
  { name: '포르단칼집밤 특(2kg)이상',   cost: 22000, price: 32800, shipping: 3000 },
  { name: '옥광밤 대(1kg)',            cost: 15000, price: 21800, shipping: 3000 },
  { name: '옥광밤 대(2kg)이상',         cost: 28000, price: 38000, shipping: 3000 },
  { name: '대보밤 특(1kg)',            cost: 11000, price: 20800, shipping: 3000 },
  { name: '대보밤 특(2kg)이상',         cost: 20000, price: 30800, shipping: 3000 },
];

// 옥수수 3종
const CORN_PRODUCTS: ProductCost[] = [
  { name: '냉동 대학찰옥수수 3x10 30개', cost: 30000, price: 52500, shipping: 3000 },
  { name: '냉동 대학찰옥수수 3x7 21개',  cost: 21000, price: 36500, shipping: 3000 },
  { name: '냉동 대학찰옥수수 3X5 15개',  cost: 15000, price: 28500, shipping: 3000 },
];

// 옵션명으로 상품 원가 찾기
function findProductCost(optionName: string, isCorn: boolean): ProductCost | null {
  const list = isCorn ? CORN_PRODUCTS : BAM_PRODUCTS;
  const opt = optionName.toLowerCase();

  if (isCorn) {
    if (opt.includes('30') || opt.includes('3x10') || opt.includes('3×10')) return list[0];
    if (opt.includes('21') || opt.includes('3x7') || opt.includes('3×7')) return list[1];
    if (opt.includes('15') || opt.includes('3x5') || opt.includes('3×5')) return list[2];
    return list[1]; // 기본값
  } else {
    // 옥광밤
    if (opt.includes('옥광')) {
      if (opt.includes('2kg')) return list[9];
      return list[8];
    }
    // 대보밤
    if (opt.includes('대보')) {
      if (opt.includes('2kg')) return list[11];
      return list[10];
    }
    // 포르단칼집밤
    if (opt.includes('포르단') || opt.includes('칼집')) {
      if (opt.includes('특')) {
        if (opt.includes('2kg')) return list[7];
        return list[6];
      }
      if (opt.includes('2kg')) return list[5];
      return list[4];
    }
    // 공주알밤 (기본)
    if (opt.includes('특')) {
      if (opt.includes('2kg')) return list[3];
      return list[2];
    }
    if (opt.includes('2kg')) return list[1];
    return list[0];
  }
}

// 상품이 옥수수인지 판별
export function isCornProduct(optionName: string): boolean {
  const opt = optionName.toLowerCase();
  return opt.includes('옥수수') || opt.includes('3x') || opt.includes('3×') || opt.includes('찰옥') || opt.includes('옥광수') || opt.includes('대학찰');
}

export interface OrderItem {
  productName: string;
  productOption: string;
  quantity: number;
  orderId: string;
  receiverName: string;
  receiverPhone: string;
  address: string;
  senderName?: string;
  senderPhone?: string;
}

// ─── 로젠택배 발주서 (밤) ───
// 컬럼: 제품, 수량, 보내시는분이름, 보내시는분전화번호, 받는분이름, 받는분전화번호, 받는분핸드폰번호, 주소, 비고, 우편번호
export function generateBamDispatchXlsx(date: string, orders: OrderItem[]): Buffer {
  const wb = XLSX.utils.book_new();

  const rows: any[][] = [
    ['제  품 ', '수량', '보내시는분이름', '보내시는분 전화번호', '받는분이름', '받는분전화번호', '받는분핸드폰번호', '주소', '비고', '우편번호 ', '상품주문번호'],
  ];

  for (const order of orders) {
    const optionName = order.productOption || order.productName || '';
    rows.push([
      optionName,
      order.quantity || 1,
      order.senderName || '셀렌',
      order.senderPhone || (process.env.SENDER_PHONE || '010-9943-3201'),
      order.receiverName || '',
      '',  // 받는분전화번호 (유선)
      order.receiverPhone || '',  // 받는분핸드폰번호
      order.address || '',
      '',  // 비고
      '',  // 우편번호
      order.orderId || '',  // 상품주문번호 (송장 입력용)
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 컬럼 너비 설정
  ws['!cols'] = [
    { wch: 30 }, { wch: 6 }, { wch: 12 }, { wch: 16 },
    { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' }) as Buffer;
}

// ─── 롯데택배 발주서 (옥수수) ───
// 컬럼: 상품주문번호, 수취인, 상품명, 수량, 연락처, 주소
export function generateCornDispatchXlsx(date: string, orders: OrderItem[]): Buffer {
  const wb = XLSX.utils.book_new();

  const rows: any[][] = [
    ['상품주문번호', '수취인', '상품명', '수량', '연락처', '주소'],
  ];

  for (const order of orders) {
    const optionName = order.productOption || order.productName || '';
    rows.push([
      order.orderId || '',
      order.receiverName || '',
      optionName,
      order.quantity || 1,
      order.receiverPhone || '',
      order.address || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 20 }, { wch: 10 }, { wch: 30 }, { wch: 6 }, { wch: 14 }, { wch: 50 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export interface SettlementResult {
  date: string;
  type: 'bam' | 'corn';
  items: Array<{
    name: string;
    qty: number;
    cost: number;
    totalCost: number;
    shipping: number;
    totalShipping: number;
    totalCostWithShipping: number;
    price: number;
    totalPrice: number;
    profit: number;
  }>;
  totalQty: number;
  totalCost: number;
  totalShipping: number;
  totalCostWithShipping: number;
  totalRevenue: number;
  totalProfit: number;
  xlsxBuffer: Buffer;
}

// ─── 정산서 엑셀 생성 ───
export function generateSettlementXlsx(
  date: string,
  orders: OrderItem[],
  type: 'bam' | 'corn'
): SettlementResult {
  const isCorn = type === 'corn';
  const title = isCorn
    ? '새벽장터 옥수수 정산서 (배송비별도)'
    : '새벽장터 공주밤 정산서 (배송비별도)';

  // 상품별 수량 집계
  const productMap = new Map<string, { qty: number; costInfo: ProductCost | null }>();
  for (const order of orders) {
    const key = order.productOption || order.productName || '';
    const existing = productMap.get(key);
    if (existing) {
      existing.qty += order.quantity || 1;
    } else {
      productMap.set(key, { qty: order.quantity || 1, costInfo: findProductCost(key, isCorn) });
    }
  }

  // 계산
  const items: SettlementResult['items'] = [];
  let totalQty = 0, totalCost = 0, totalShipping = 0, totalRevenue = 0;

  for (const [name, { qty, costInfo }] of productMap.entries()) {
    const unitCost = costInfo?.cost || 0;
    const unitPrice = costInfo?.price || 0;
    const unitShipping = costInfo?.shipping || 3000;
    const totalItemCost = unitCost * qty;
    const totalItemShipping = unitShipping * qty;
    const totalItemCostWithShipping = totalItemCost + totalItemShipping;
    const totalItemPrice = unitPrice * qty;
    const profit = totalItemPrice - totalItemCostWithShipping;

    items.push({
      name, qty,
      cost: unitCost, totalCost: totalItemCost,
      shipping: unitShipping, totalShipping: totalItemShipping,
      totalCostWithShipping: totalItemCostWithShipping,
      price: unitPrice, totalPrice: totalItemPrice,
      profit,
    });

    totalQty += qty;
    totalCost += totalItemCost;
    totalShipping += totalItemShipping;
    totalRevenue += totalItemPrice;
  }

  const totalCostWithShipping = totalCost + totalShipping;
  const totalProfit = totalRevenue - totalCostWithShipping;

  // 엑셀 생성
  const wb = XLSX.utils.book_new();

  // ─ 새벽장터용 시트 ─
  const ws1Data: any[][] = [
    [title],
    [], [], [], [],
    ['날짜', null, date, null, null, null, '담당자', '이혜안', '배송비', 3000],
    ['제품명', null, '수량', '제품원가', null, '배송비', '제품원가+배송비', '매출액', null, '순수익'],
  ];

  for (const item of items) {
    ws1Data.push([
      item.name, null, item.qty,
      item.cost, item.totalCost,
      item.totalShipping, item.totalCostWithShipping,
      item.totalPrice, item.totalPrice,
      item.profit,
    ]);
  }

  // 빈 행 패딩
  while (ws1Data.length < 22) ws1Data.push([]);

  ws1Data.push(['합계', null, totalQty, totalCost, totalCost, totalShipping, totalCostWithShipping, totalRevenue, totalRevenue, totalProfit]);
  ws1Data.push([]);
  ws1Data.push([null, null, null, null, '날짜', '제품원가', '배송비', '정산금', '매출액', '순수익']);
  ws1Data.push([null, null, null, null, date, totalCost, totalShipping, totalCostWithShipping, totalRevenue, totalProfit]);
  ws1Data.push([]);
  ws1Data.push([null, null, null, null, null, null, '금일 정산내역 확인 부탁드립니다!']);

  const ws1 = XLSX.utils.aoa_to_sheet(ws1Data);
  XLSX.utils.book_append_sheet(wb, ws1, '새벽장터용');

  // ─ 공급자용 시트 ─
  const ws2Data: any[][] = [
    [title],
    [], [], [], [],
    ['날짜', date, null, '담당자', '이혜안', '배송비', 3000],
    ['제품명', null, '수량', '제품원가', null, '배송비', '제품원가+배송비'],
  ];

  for (const item of items) {
    ws2Data.push([item.name, null, item.qty, item.cost, item.totalCost, item.totalShipping, item.totalCostWithShipping]);
  }

  while (ws2Data.length < 22) ws2Data.push([]);

  ws2Data.push(['합계', null, totalQty, totalCost, totalCost, totalShipping, totalCostWithShipping]);
  ws2Data.push([]);
  ws2Data.push([null, null, null, '날짜', '제품원가', '배송비', '정산금']);
  ws2Data.push([null, null, null, date, totalCost, totalShipping, totalCostWithShipping]);
  ws2Data.push([]);
  ws2Data.push([null, null, null, '금일 정산내역 확인 부탁드립니다!']);

  const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
  XLSX.utils.book_append_sheet(wb, ws2, '공급자용');

  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return { date, type, items, totalQty, totalCost, totalShipping, totalCostWithShipping, totalRevenue, totalProfit, xlsxBuffer };
}

// ─── 원가 계산 요약 텍스트 ───
export function calcCostSummary(bamOrders: OrderItem[], cornOrders: OrderItem[]): string {
  let msg = '';

  if (bamOrders.length > 0) {
    const r = generateSettlementXlsx('', bamOrders, 'bam');
    msg += `\n🌰 <b>밤 원가 계산</b>\n`;
    msg += `  수량: ${r.totalQty}건 / 원가: ${r.totalCost.toLocaleString('ko-KR')}원\n`;
    msg += `  배송비: ${r.totalShipping.toLocaleString('ko-KR')}원 / 매출: ${r.totalRevenue.toLocaleString('ko-KR')}원\n`;
    msg += `  💰 순수익: <b>${r.totalProfit.toLocaleString('ko-KR')}원</b>\n`;
  }

  if (cornOrders.length > 0) {
    const r = generateSettlementXlsx('', cornOrders, 'corn');
    msg += `\n🌽 <b>옥수수 원가 계산</b>\n`;
    msg += `  수량: ${r.totalQty}건 / 원가: ${r.totalCost.toLocaleString('ko-KR')}원\n`;
    msg += `  배송비: ${r.totalShipping.toLocaleString('ko-KR')}원 / 매출: ${r.totalRevenue.toLocaleString('ko-KR')}원\n`;
    msg += `  💰 순수익: <b>${r.totalProfit.toLocaleString('ko-KR')}원</b>\n`;
  }

  return msg;
}

// ─── 통합주문서 파싱 ───
export interface ParsedOrderSheet {
  bamOrders: OrderItem[];
  cornOrders: OrderItem[];
  unknownOrders: OrderItem[];
  totalCount: number;
}

export function parseNaverOrderSheet(fileBuffer: Buffer, password: string = '1234'): ParsedOrderSheet {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer', password });
  } catch {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  }

  const sheetName = wb.SheetNames.includes('발주발송관리')
    ? '발주발송관리'
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i] && rows[i].some((v: any) => String(v).includes('상품주문번호'))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) headerRowIdx = 1;

  const headers: string[] = rows[headerRowIdx].map((v: any) => String(v || ''));
  const colIdx = (name: string) => headers.findIndex(h => h.includes(name));

  const idxOrderId  = colIdx('상품주문번호');
  const idxReceiver = colIdx('수취인명');
  const idxOption   = colIdx('옵션정보');
  const idxQty      = colIdx('수량');
  const idxPhone    = colIdx('수취인연락처1');
  const idxAddress  = colIdx('통합배송지');

  const bamOrders: OrderItem[] = [];
  const cornOrders: OrderItem[] = [];
  const unknownOrders: OrderItem[] = [];

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((v: any) => v !== '' && v !== null && v !== undefined)) continue;

    const orderId  = String(row[idxOrderId] || '').replace(/\.0$/, '');
    const receiver = String(row[idxReceiver] || '');
    const option   = String(row[idxOption] || '');
    const qty      = Number(row[idxQty]) || 1;
    const phone    = String(row[idxPhone] || '');
    const address  = String(row[idxAddress] || '');

    if (!option && !receiver) continue;

    const item: OrderItem = {
      productName: option,
      productOption: option,
      quantity: qty,
      orderId,
      receiverName: receiver,
      receiverPhone: phone,
      address,
      senderName: '셀렌',
      senderPhone: process.env.SENDER_PHONE || '010-9943-3201',
    };

    if (isCornProduct(option)) {
      cornOrders.push(item);
    } else if (option.includes('밤') || option.includes('포르단') || option.includes('알밤') || option.includes('옥광') || option.includes('대보')) {
      bamOrders.push(item);
    } else {
      unknownOrders.push(item);
    }
  }

  return { bamOrders, cornOrders, unknownOrders, totalCount: bamOrders.length + cornOrders.length + unknownOrders.length };
}
