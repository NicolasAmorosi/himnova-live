import { expect, relaunch, test } from "./support/app";

// The one spec that starts like a church's first launch does: main welcomes a new profile.
test.use({ welcome: true });

test("a new profile is welcomed, every step saves as it goes, and finishing opens «Primeros pasos»", async ({ app }) => {
  const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole("heading", { name: "Te damos la bienvenida a Lumina Live" })).toBeVisible();
  // Escape must not throw the guide away.
  await app.control.keyboard.press("Escape");
  await expect(welcome).toBeVisible();

  await welcome.getByRole("button", { name: "Siguiente: Tu iglesia" }).click();
  await welcome.getByRole("button", { name: "Nombre sobre fondo" }).click();
  const name = welcome.getByRole("textbox", { name: "Nombre de la iglesia" });
  await name.fill("Iglesia Central");
  await name.press("Enter");

  // Any step from the rail; «Al terminar»: a video ends on black.
  await welcome.getByRole("tab", { name: "Al terminar" }).click();
  await welcome.getByRole("radiogroup", { name: "Un video" }).getByRole("radio", { name: "Negro" }).click();
  await expect(welcome.getByRole("radiogroup", { name: "Un video" }).getByRole("radio", { name: "Negro" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await welcome.getByRole("tab", { name: "Listo" }).click();
  await expect(welcome.getByText("«Iglesia Central»")).toBeVisible();
  await expect(welcome.getByText(/Video: Negro/)).toBeVisible();
  await welcome.getByRole("button", { name: "Empezar", exact: true }).click();
  await expect(welcome).toBeHidden();

  // «Primeros pasos» ticks itself: a verse in PREVIEW, then live.
  const steps = app.control.getByRole("complementary", { name: "Primeros pasos" });
  await expect(steps).toBeVisible();
  await expect(steps.getByText("0 de 6")).toBeVisible();
  await app.openChapter("Juan 3");
  await app.control.getByRole("listitem").filter({ hasText: "Porque de tal manera amó Dios al mundo" }).click();
  await expect(steps.getByText("1 de 6")).toBeVisible();
  await app.goLive();
  await expect(steps.getByText("2 de 6")).toBeVisible();
  // Songs: opening the tab is enough, nothing has to be made (owner, 2026-11-09).
  await app.openResources("Canciones");
  await expect(steps.getByText("3 de 6")).toBeVisible();

  // Chosen once, kept: the next launch neither welcomes again nor forgets the choices.
  await app.quit();
  const again = await relaunch(app);
  await expect(again.control.getByRole("dialog", { name: "Bienvenida" })).toBeHidden();
  await expect(again.control.getByRole("complementary", { name: "Primeros pasos" }).getByText("3 de 6")).toBeVisible();
});

test("skipping keeps what was chosen, and the guide reopens from Settings ▸ About", async ({ app }) => {
  const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
  await welcome.getByRole("radio", { name: "Claro" }).click();
  await expect(app.control.locator("html")).toHaveAttribute("data-theme", "light");
  await welcome.getByRole("button", { name: "Saltar la bienvenida" }).click();
  await expect(welcome).toBeHidden();
  await expect(app.control.locator("html")).toHaveAttribute("data-theme", "light");

  await app.control.getByRole("button", { name: "Configuración" }).click();
  const settings = app.control.getByRole("dialog", { name: "Configuración" });
  await settings.getByRole("tab", { name: "Acerca de" }).click();
  await settings.getByRole("button", { name: "Abrir la guía" }).click();
  await expect(welcome).toBeVisible();
  await expect(settings).toBeHidden();
});

test("the Bibles step installs a bundled version and draws it beside the main one", async ({ app }) => {
  const welcome = app.control.getByRole("dialog", { name: "Bienvenida" });
  await welcome.getByRole("tab", { name: "Biblias" }).click();
  const included = welcome.getByRole("list", { name: "Versiones incluidas" });
  // A Spanish profile starts with its language's version installed; the others are «Instalar», as in Settings.
  await expect(included.getByRole("group", { name: "Reina-Valera 1909" })).toContainText("Instalada");
  await included.getByRole("group", { name: "King James Version" }).getByRole("button", { name: "Instalar" }).click();
  await expect(included.getByRole("group", { name: "King James Version" })).toContainText("Instalada");

  await welcome.getByRole("group", { name: "En paralelo" }).getByRole("combobox").click();
  await app.control.getByRole("option", { name: "King James Version", exact: true }).click();
  // The sample verse, in both versions, as the room will see it.
  await expect(welcome.getByText("Juan 3:16")).toBeVisible();
  await expect(welcome.getByText("John 3:16")).toBeVisible();
});

test("choosing another language on a first launch swaps the profile's Bibles for that language's", async ({ app }) => {
  await app.control.getByRole("dialog", { name: "Bienvenida" }).getByRole("radio", { name: "English" }).click();
  const welcome = app.control.getByRole("dialog", { name: "Welcome" });
  await welcome.getByRole("tab", { name: "Bibles" }).click();
  const included = welcome.getByRole("list", { name: "Included versions" });
  for (const name of ["King James Version", "American Standard Version", "World English Bible"]) {
    await expect(included.getByRole("group", { name })).toContainText("Installed");
  }
  await expect(included.getByRole("group", { name: "Reina-Valera 1909" }).getByRole("button", { name: "Install" })).toBeVisible();
  await expect(welcome.getByRole("group", { name: "Main version" }).getByRole("combobox")).toContainText("King James Version");
});
