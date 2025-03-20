import { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];

// 기존 테이블 타입 활용
type User = Tables["user"]["Row"];
type Workspace = Tables["llami_workspace"]["Row"];
type Product = Tables["llami_product"]["Row"];
type Card = Tables["llami_billing_card"]["Row"];
type Subscription = Tables["llami_subscription"]["Row"];

// 결제 상태 enum
export enum BillingStatus {
  SUCCESS = "결제승인",
  MISSING_CARD = "BILLING_MISSING_CARD",
  MISSING_PRODUCT = "BILLING_MISSING_PRODUCT",
  MISSING_WORKSPACE = "BILLING_MISSING_WORKSPACE",
  MISSING_USER = "BILLING_MISSING_USER",
  CARD_PAYMENT_FAILED = "BILLING_CARD_PAYMENT_FAILED",
  NETWORK_ERROR = "BILLING_NETWORK_ERROR",
}

// 구독 정보 타입 (JOIN 결과)
export interface SubscriptionInfo extends Subscription {
  card?: Card;
  product?: Product;
  workspace?: Workspace & {
    user?: User;
  };
}

// 결제 결과 타입
export interface PaymentResult {
  subscription_id: string;
  workspace_id: string;
  status: BillingStatus;
  amount?: number;
  payment_at: string;
  user?: User;
  service_name: string;
  payer_phone_number: string;
  payer_id: string;
  payment_method: string;
  payment_type: string;
}
