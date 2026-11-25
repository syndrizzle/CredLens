import { RouterProvider } from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme";
import { router } from "@/app/router";

function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}

export default App;
