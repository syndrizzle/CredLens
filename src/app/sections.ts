import {
  AiChat02Icon,
  Analytics01Icon,
  DashboardSquare01Icon,
  Note01Icon,
  Pdf01Icon,
  Settings01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";

// `group` places the link in the sidebar; `account` pages need a signed-in, saved business.
const SECTIONS = [
  { id: "overview", path: "/", title: "Overview", icon: DashboardSquare01Icon, group: "main", account: false },
  { id: "documents", path: "/documents", title: "Documents", icon: Pdf01Icon, group: "Data", account: true },
  { id: "figures", path: "/figures", title: "Figures", icon: Table01Icon, group: "Data", account: false },
  { id: "analysis", path: "/analysis", title: "Analysis", icon: Analytics01Icon, group: "Insights", account: false },
  { id: "reports", path: "/reports", title: "Reports", icon: Note01Icon, group: "Insights", account: true },
  { id: "assistant", path: "/assistant", title: "Assistant", icon: AiChat02Icon, group: "Insights", account: true },
  { id: "settings", path: "/settings", title: "Settings", icon: Settings01Icon, group: "footer", account: true },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

export { SECTIONS, type Section };
