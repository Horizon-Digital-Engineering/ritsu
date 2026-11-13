/**
 * Default category tree, the provider-category map seeded from it, and the
 * keyword categorizer used when a provider supplies no category at all.
 * Everything here is a seed: the operator edits categories, the map and the
 * rules afterwards, and sync never overwrites a category the operator set.
 */
import type { PluginDb } from '../types.js';

export type CategoryKind = 'expense' | 'income' | 'transfer';

export interface CategorySeed { id: string; name: string; group: string; kind: CategoryKind }

const C = (id: string, name: string, group: string, kind: CategoryKind = 'expense'): CategorySeed => ({ id, name, group, kind });

export const UNCATEGORIZED = 'uncategorized';

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  C('paycheck', 'Paycheck', 'Income', 'income'),
  C('interest', 'Interest', 'Income', 'income'),
  C('dividends', 'Dividends', 'Income', 'income'),
  C('refunds', 'Refunds & Reimbursements', 'Income', 'income'),
  C('other_income', 'Other Income', 'Income', 'income'),

  C('transfer', 'Transfer', 'Transfers', 'transfer'),
  C('credit_card_payment', 'Credit Card Payment', 'Transfers', 'transfer'),

  C('rent_mortgage', 'Rent & Mortgage', 'Housing'),
  C('home_improvement', 'Home Improvement', 'Housing'),
  C('home_services', 'Home Services', 'Housing'),

  C('utilities', 'Utilities', 'Bills & Utilities'),
  C('internet_phone', 'Internet & Phone', 'Bills & Utilities'),
  C('insurance', 'Insurance', 'Bills & Utilities'),

  C('groceries', 'Groceries', 'Food & Dining'),
  C('restaurants', 'Restaurants & Bars', 'Food & Dining'),
  C('coffee', 'Coffee Shops', 'Food & Dining'),

  C('gas', 'Gas', 'Transportation'),
  C('auto_payment', 'Auto Payment', 'Transportation'),
  C('auto_maintenance', 'Auto Maintenance', 'Transportation'),
  C('parking_tolls', 'Parking & Tolls', 'Transportation'),
  C('public_transit', 'Public Transit', 'Transportation'),
  C('rideshare', 'Taxi & Rideshare', 'Transportation'),

  C('shopping', 'Shopping', 'Shopping'),
  C('clothing', 'Clothing', 'Shopping'),
  C('electronics', 'Electronics', 'Shopping'),
  C('home_goods', 'Home Goods', 'Shopping'),

  C('medical', 'Medical', 'Health & Wellness'),
  C('pharmacy', 'Pharmacy', 'Health & Wellness'),
  C('fitness', 'Fitness', 'Health & Wellness'),

  C('entertainment', 'Entertainment', 'Entertainment'),
  C('subscriptions', 'Subscriptions', 'Entertainment'),
  C('travel', 'Travel & Vacation', 'Entertainment'),

  C('personal_care', 'Personal Care', 'Personal'),
  C('education', 'Education', 'Personal'),
  C('gifts_donations', 'Gifts & Donations', 'Personal'),
  C('pets', 'Pets', 'Personal'),
  C('childcare', 'Child Care', 'Personal'),

  C('fees', 'Fees & Charges', 'Financial'),
  C('taxes', 'Taxes', 'Financial'),
  C('loan_payment', 'Loan Payment', 'Financial'),
  C('investments', 'Investments', 'Financial'),

  C('business', 'Business Expense', 'Business'),
  C(UNCATEGORIZED, 'Uncategorized', 'Other'),
];

/** Plaid personal-finance categories (detailed first, primary as fallback). */
export const PROVIDER_CATEGORY_MAP: Record<string, string> = {
  INCOME_WAGES: 'paycheck', INCOME_DIVIDENDS: 'dividends', INCOME_INTEREST_EARNED: 'interest',
  INCOME_TAX_REFUND: 'refunds', INCOME_RETIREMENT_PENSION: 'other_income', INCOME_UNEMPLOYMENT: 'other_income',
  INCOME_OTHER_INCOME: 'other_income', INCOME: 'other_income',
  TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'investments', TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'investments',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'credit_card_payment', LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'rent_mortgage',
  LOAN_PAYMENTS_CAR_PAYMENT: 'auto_payment', LOAN_PAYMENTS: 'loan_payment',
  BANK_FEES: 'fees',
  ENTERTAINMENT_TV_AND_MOVIES: 'subscriptions', ENTERTAINMENT_MUSIC_AND_AUDIO: 'subscriptions', ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK_GROCERIES: 'groceries', FOOD_AND_DRINK_COFFEE: 'coffee', FOOD_AND_DRINK: 'restaurants',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'clothing', GENERAL_MERCHANDISE_ELECTRONICS: 'electronics',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'pets', GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'gifts_donations',
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: 'education', GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT_FURNITURE: 'home_goods', HOME_IMPROVEMENT: 'home_improvement',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'pharmacy', MEDICAL_VETERINARY_SERVICES: 'pets', MEDICAL: 'medical',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'fitness', PERSONAL_CARE: 'personal_care',
  GENERAL_SERVICES_EDUCATION: 'education', GENERAL_SERVICES_INSURANCE: 'insurance', GENERAL_SERVICES_CHILDCARE: 'childcare',
  GENERAL_SERVICES_AUTOMOTIVE: 'auto_maintenance', GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: 'fees',
  GENERAL_SERVICES: 'home_services',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'gifts_donations', GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'taxes',
  GOVERNMENT_AND_NON_PROFIT: 'fees',
  TRANSPORTATION_GAS: 'gas', TRANSPORTATION_PARKING: 'parking_tolls', TRANSPORTATION_TOLLS: 'parking_tolls',
  TRANSPORTATION_PUBLIC_TRANSIT: 'public_transit', TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'rideshare',
  TRANSPORTATION: 'auto_maintenance',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES_RENT: 'rent_mortgage', RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'internet_phone',
  RENT_AND_UTILITIES_TELEPHONE: 'internet_phone', RENT_AND_UTILITIES: 'utilities',
};

/** Keyword fallback for providers that send no category. First match wins. */
const KEYWORDS: Array<[RegExp, string]> = [
  [/payroll|direct dep|salary|gusto|adp\b/i, 'paycheck'],
  [/interest paid|interest earned|\binterest\b/i, 'interest'],
  [/dividend/i, 'dividends'],
  [/refund|reimburse/i, 'refunds'],
  [/autopay|payment thank you|card payment|cardmember|epayment/i, 'credit_card_payment'],
  [/venmo|zelle|paypal|cash app|transfer|xfer/i, 'transfer'],
  [/mortgage|rent\b/i, 'rent_mortgage'],
  [/netflix|spotify|hulu|disney|hbo|max\.com|apple\.com\/bill|youtube|audible|patreon|substack|icloud/i, 'subscriptions'],
  [/comcast|xfinity|verizon|at&t|t-mobile|spectrum|cox\b|frontier|fios/i, 'internet_phone'],
  [/electric|power co|water|sewer|gas co|pg&e|duke energy|utility|utilities/i, 'utilities'],
  [/geico|state farm|progressive|allstate|insurance/i, 'insurance'],
  [/whole foods|trader joe|kroger|safeway|aldi|publix|wegmans|h-e-b|heb\b|costco|sprouts|grocery|market/i, 'groceries'],
  [/starbucks|dunkin|coffee|peet/i, 'coffee'],
  [/mcdonald|chipotle|doordash|grubhub|uber eats|restaurant|pizza|taco|burger|sushi|grill|cafe|bar\b/i, 'restaurants'],
  [/shell|chevron|exxon|mobil|\bbp\b|texaco|sunoco|wawa|fuel|gas station/i, 'gas'],
  [/uber|lyft|taxi/i, 'rideshare'],
  [/parking|toll/i, 'parking_tolls'],
  [/amazon|amzn|target|walmart|best buy|ebay|etsy/i, 'shopping'],
  [/cvs|walgreens|rite aid|pharmacy/i, 'pharmacy'],
  [/gym|fitness|peloton|planet fit|crossfit/i, 'fitness'],
  [/airline|airways|delta|united|southwest|jetblue|alaska air|airbnb|hotel|marriott|hilton|hyatt|expedia/i, 'travel'],
  [/\bfee\b|service charge|overdraft/i, 'fees'],
  [/irs|tax/i, 'taxes'],
  [/vet\b|petco|petsmart|chewy/i, 'pets'],
  [/doctor|clinic|hospital|dental|medical/i, 'medical'],
];

export function categorizeByKeyword(text: string): string | null {
  for (const [re, id] of KEYWORDS) if (re.test(text)) return id;
  return null;
}

export function seedCategories(db: PluginDb): void {
  const cats = db.table('categories');
  const map = db.table('provider_category_map');
  const insCat = db.prepare(`INSERT OR IGNORE INTO ${cats} (id, name, group_name, kind, sort, builtin) VALUES (?, ?, ?, ?, ?, 1)`);
  DEFAULT_CATEGORIES.forEach((c, i) => insCat.run(c.id, c.name, c.group, c.kind, i));
  const insMap = db.prepare(`INSERT OR IGNORE INTO ${map} (provider_category, category_id) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(PROVIDER_CATEGORY_MAP)) insMap.run(k, v);
}
