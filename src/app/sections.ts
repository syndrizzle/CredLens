import {
  AiChat02Icon,
  Analytics01Icon,
  DashboardSquare01Icon,
  Note01Icon,
  Pdf01Icon,
  Settings01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";

// `group` places the link in the sidebar. `requires` locks the page for guests (and, for "business", until the business is saved); `offers` finishes the prompt shown instead.
const SECTIONS = [
  { id: "overview", path: "/", title: "Overview", icon: DashboardSquare01Icon, group: "main", requires: null, offers: null },
  { id: "documents", path: "/documents", title: "Documents", icon: Pdf01Icon, group: "Data", requires: "business", offers: "upload statement PDFs" },
  { id: "figures", path: "/figures", title: "Figures", icon: Table01Icon, group: "Data", requires: null, offers: null },
  { id: "analysis", path: "/analysis", title: "Analysis", icon: Analytics01Icon, group: "Insights", requires: null, offers: null },
  { id: "reports", path: "/reports", title: "Reports", icon: Note01Icon, group: "Insights", requires: "business", offers: "create reports for your accountant or lender" },
  { id: "assistant", path: "/assistant", title: "Assistant", icon: AiChat02Icon, group: "Insights", requires: "business", offers: "ask questions about your figures and documents" },
  { id: "settings", path: "/settings", title: "Settings", icon: Settings01Icon, group: "footer", requires: "account", offers: "manage your account" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

export { SECTIONS, type Section };
