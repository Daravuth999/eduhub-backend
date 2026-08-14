export interface StudentData {
  Name: string;
  StudentID: string;
  Password: string;
  Pronunciation?: number | string;
  Intonation?: number | string;
  Communication?: number | string;
  Participation?: number | string;
  "Rising & Falling"?: number | string;
  "Linking Sounds"?: number | string;
  Strength?: string;
  Weakness?: string;
  Improvement?: string;
  TuitionStatus?: "paid" | "pending" | "unpaid" | string;
  LastPaymentDate?: string;
  NextDueDate?: string;
  PaymentAmount?: number;
  Restriction?: string;
  restriction?: string;
  error?: string;
}

export interface CommentItem {
  teacherName?: string;
  type?: "positive" | "improvement" | "general" | string;
  date?: string;
  comment?: string;
  text?: string;
}

export interface PerformanceHistoryItem {
  date: string;
  overallScore: number;
  pronunciation: number;
  intonation: number;
  communication: number;
  participation: number;
  risingFalling: number;
  linkingSounds: number;
}

export interface PointsTransfer {
  direction: "sent" | "received";
  from?: string;
  to?: string;
  amount: number;
  date: string;
}

export interface CouponResult {
  success: boolean;
  discountPercent?: number;
  newAmount?: number;
  message?: string;
}

export interface PointsLogin {
  success: boolean;
  points?: number;
}

export interface SendPointsResult {
  success: boolean;
  msg?: string;
  transferId?: string;
  receiverName?: string;
}

export interface ReceiptData {
  transferId: string;
  amount: number;
  receiverId: string;
  receiverName: string;
  senderName: string;
  senderId: string;
  newBalance: number;
  date: string;
}

export type CriterionKey =
  | "pronunciation"
  | "intonation"
  | "communication"
  | "participation"
  | "risingFalling"
  | "linkingSounds";

export interface Scores {
  pronunciation: number;
  intonation: number;
  communication: number;
  participation: number;
  risingFalling: number;
  linkingSounds: number;
}

export type Lang = "en" | "km";
