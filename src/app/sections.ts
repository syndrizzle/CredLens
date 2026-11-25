import {
  Analytics01Icon,
  BubbleChatQuestionIcon,
  DashboardSquare01Icon,
  Note01Icon,
  Pdf01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";

const SECTIONS = [
  { id: "overview", path: "/", title: "Overview", icon: DashboardSquare01Icon },
  { id: "figures", path: "/figures", title: "Figures", icon: Table01Icon },
  { id: "documents", path: "/documents", title: "Documents", icon: Pdf01Icon },
  { id: "analysis", path: "/analysis", title: "Analysis", icon: Analytics01Icon },
  { id: "report", path: "/report", title: "Report", icon: Note01Icon },
  { id: "qa", path: "/qa", title: "Q&A", icon: BubbleChatQuestionIcon },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

export { SECTIONS, type Section };
