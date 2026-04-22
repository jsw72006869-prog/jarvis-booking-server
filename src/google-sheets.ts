/**
 * Google Sheets 연동 모듈
 * 정산서/발주서를 구글 시트에 자동 입력 후 공유 링크 반환
 * 
 * 필요 환경변수:
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL: 서비스 계정 이메일
 * - GOOGLE_PRIVATE_KEY: 서비스 계정 비공개 키 (JSON에서 추출)
 * - GOOGLE_SPREADSHEET_ID: 기본 스프레드시트 ID (선택)
 */

import { google } from 'googleapis';
import type { OrderItem } from './settlement';
import { generateSettlementXlsx, isCornProduct, BAM_PRODUCTS, CORN_PRODUCTS } from './settlement';

// ─── Google Auth 설정 ───
function getGoogleAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error('Google 서비스 계정 설정이 없습니다.\nGOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY 환경변수를 확인하세요.');
  }

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

// ─── 새 스프레드시트 생성 ───
async function createSpreadsheet(title: string): Promise<{ spreadsheetId: string; url: string }> {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: '새벽장터용' } },
        { properties: { title: '공급자용' } },
      ],
    },
  });

  const spreadsheetId = response.data.spreadsheetId!;
  const url = response.data.spreadsheetUrl!;

  // 누구나 볼 수 있도록 공유 설정
  const drive = google.drive({ version: 'v3', auth });
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return { spreadsheetId, url };
}

// ─── 정산서를 구글 시트에 입력 ───
export async function writeSettlementToGoogleSheet(
  dateStr: string,
  orders: OrderItem[],
  type: 'bam' | 'corn'
): Promise<{ url: string; spreadsheetId: string }> {
  const isCorn = type === 'corn';
  const typeName = isCorn ? '옥수수' : '밤';
  const title = `[정산서] ${dateStr} ${typeName} - 새벽장터`;

  // 정산 데이터 계산
  const settlement = generateSettlementXlsx(dateStr, orders, type);

  // 새 스프레드시트 생성
  const { spreadsheetId, url } = await createSpreadsheet(title);
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // ─ 새벽장터용 시트 데이터 ─
  const ws1Data: any[][] = [
    [isCorn ? '새벽장터 옥수수 정산서 (배송비별도)' : '새벽장터 공주밤 정산서 (배송비별도)'],
    [],
    ['날짜', '', dateStr, '', '', '', '담당자', '이혜안', '배송비', 3000],
    ['제품명', '', '수량', '제품원가', '원가합계', '배송비', '제품원가+배송비', '매출액', '', '순수익'],
  ];

  for (const item of settlement.items) {
    ws1Data.push([
      item.name, '', item.qty,
      item.cost, item.totalCost,
      item.totalShipping, item.totalCostWithShipping,
      item.totalPrice, '',
      item.profit,
    ]);
  }

  ws1Data.push([]);
  ws1Data.push([
    '합계', '', settlement.totalQty,
    settlement.totalCost, settlement.totalCost,
    settlement.totalShipping, settlement.totalCostWithShipping,
    settlement.totalRevenue, '',
    settlement.totalProfit,
  ]);
  ws1Data.push([]);
  ws1Data.push(['', '', '', '', '날짜', '제품원가', '배송비', '정산금', '매출액', '순수익']);
  ws1Data.push(['', '', '', '', dateStr, settlement.totalCost, settlement.totalShipping, settlement.totalCostWithShipping, settlement.totalRevenue, settlement.totalProfit]);
  ws1Data.push([]);
  ws1Data.push(['', '', '', '', '', '', '금일 정산내역 확인 부탁드립니다!']);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: '새벽장터용!A1',
    valueInputOption: 'RAW',
    requestBody: { values: ws1Data },
  });

  // ─ 공급자용 시트 데이터 ─
  const ws2Data: any[][] = [
    [isCorn ? '새벽장터 옥수수 정산서 (배송비별도)' : '새벽장터 공주밤 정산서 (배송비별도)'],
    [],
    ['날짜', dateStr, '', '담당자', '이혜안', '배송비', 3000],
    ['제품명', '', '수량', '제품원가', '원가합계', '배송비', '제품원가+배송비'],
  ];

  for (const item of settlement.items) {
    ws2Data.push([item.name, '', item.qty, item.cost, item.totalCost, item.totalShipping, item.totalCostWithShipping]);
  }

  ws2Data.push([]);
  ws2Data.push(['합계', '', settlement.totalQty, settlement.totalCost, settlement.totalCost, settlement.totalShipping, settlement.totalCostWithShipping]);
  ws2Data.push([]);
  ws2Data.push(['', '', '', '날짜', '제품원가', '배송비', '정산금']);
  ws2Data.push(['', '', '', dateStr, settlement.totalCost, settlement.totalShipping, settlement.totalCostWithShipping]);
  ws2Data.push([]);
  ws2Data.push(['', '', '', '금일 정산내역 확인 부탁드립니다!']);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: '공급자용!A1',
    valueInputOption: 'RAW',
    requestBody: { values: ws2Data },
  });

  return { url, spreadsheetId };
}

// ─── 발주서를 구글 시트에 입력 ───
export async function writeDispatchToGoogleSheet(
  dateStr: string,
  bamOrders: OrderItem[],
  cornOrders: OrderItem[]
): Promise<{ url: string; spreadsheetId: string }> {
  const title = `[발주서] ${dateStr} - 새벽장터`;

  const auth = getGoogleAuth();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  // 시트 구성
  const sheetNames: string[] = [];
  if (bamOrders.length > 0) sheetNames.push('밤_로젠택배');
  if (cornOrders.length > 0) sheetNames.push('옥수수_롯데택배');
  if (sheetNames.length === 0) sheetNames.push('Sheet1');

  const response = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetNames.map(name => ({ properties: { title: name } })),
    },
  });

  const spreadsheetId = response.data.spreadsheetId!;
  const url = response.data.spreadsheetUrl!;

  // 공유 설정
  const drive = google.drive({ version: 'v3', auth });
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // 밤 발주서 데이터
  if (bamOrders.length > 0) {
    const bamData: any[][] = [
      ['제품', '수량', '보내시는분이름', '보내시는분전화번호', '받는분이름', '받는분전화번호', '받는분핸드폰번호', '주소', '비고', '우편번호', '상품주문번호'],
    ];
    for (const o of bamOrders) {
      bamData.push([
        o.productOption || o.productName, o.quantity,
        o.senderName || '셀렌', o.senderPhone || process.env.SENDER_PHONE || '',
        o.receiverName, '', o.receiverPhone,
        o.address, '', '', o.orderId,
      ]);
    }
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: '밤_로젠택배!A1',
      valueInputOption: 'RAW',
      requestBody: { values: bamData },
    });
  }

  // 옥수수 발주서 데이터
  if (cornOrders.length > 0) {
    const cornData: any[][] = [
      ['상품주문번호', '수취인', '상품명', '수량', '연락처', '주소'],
    ];
    for (const o of cornOrders) {
      cornData.push([
        o.orderId, o.receiverName,
        o.productOption || o.productName, o.quantity,
        o.receiverPhone, o.address,
      ]);
    }
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: '옥수수_롯데택배!A1',
      valueInputOption: 'RAW',
      requestBody: { values: cornData },
    });
  }

  return { url, spreadsheetId };
}

// ─── 구글 시트 연동 가능 여부 확인 ───
export function isGoogleSheetsConfigured(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}
