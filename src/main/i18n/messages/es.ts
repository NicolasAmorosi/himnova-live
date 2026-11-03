/** What main itself says to the operator: the app menu, its own dialogs, and
 *  the errors that reach a toast or a panel. Spanish is the reference locale,
 *  as in the renderer: `MainMessages` is this file's type. */
const es = {
  window: { projectionTitle: "Lumina Live — Proyección" },
  menu: {
    about: "Acerca de {app}",
    services: "Servicios",
    hide: "Ocultar {app}",
    hideOthers: "Ocultar otros",
    showAll: "Mostrar todo",
    quitApp: "Salir de {app}",
    edit: "Edición",
    undo: "Deshacer",
    redo: "Rehacer",
    cut: "Cortar",
    copy: "Copiar",
    paste: "Pegar",
    selectAll: "Seleccionar todo",
    view: "Ver",
    actualSize: "Tamaño real",
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    fullScreen: "Pantalla completa",
    reload: "Recargar",
    forceReload: "Forzar recarga",
    devTools: "Herramientas de desarrollo",
    window: "Ventana",
    minimize: "Minimizar",
    zoom: "Zoom",
    bringAllToFront: "Traer todo al frente",
    file: "Archivo",
    quit: "Salir",
  },
  dialogs: {
    dbErrorTitle: "Error al iniciar la base de datos",
    dbErrorMigrations: "No se pudieron aplicar las migraciones.",
    dbErrorBackup: "Se conservó una copia de seguridad verificada en\n{path}",
    dbErrorNoBackup: "No hay una copia de seguridad previa a esta migración.",
    crashTitle: "Error inesperado",
  },
  /** The file type names an open dialog lists (Windows and Linux show them). */
  filters: {
    all: "Archivos compatibles",
    video: "Videos",
    image: "Imágenes",
    audio: "Audios",
    ppt: "Presentaciones",
    bibles: "Biblias",
    sqliteModules: "Módulos SQLite (MyBible, MySword)",
  },
  slides: {
    diskFull: "No hay suficiente espacio en disco para convertir la presentación.",
    shuttingDown: "La aplicación se está cerrando.",
    noLongerVisible: "Ya no está visible.",
    prewarmCanceled: "Preparación cancelada.",
    canceled: "Conversión cancelada.",
    notInLibrary: "No se encontró el archivo en la biblioteca.",
    sourceGone: "El archivo ya no está disponible: {path}",
    noSlides: "La presentación no produjo ninguna diapositiva.",
    deckUnreadable: "No se pudo leer la presentación recién preparada.",
    rasterCrashed: "El proceso de rasterizado se cerró inesperadamente.",
    rasterHung: "El rasterizado de una página se colgó.",
    pdfPassword: "El PDF está protegido con contraseña y no se puede convertir.",
    deckPassword:
      "La presentación tiene contraseña para abrirla. Abrila en PowerPoint, quitale la contraseña (Archivo ▸ Información ▸ Proteger presentación) y guardala de nuevo.",
    deckOldFormat:
      "La presentación es de PowerPoint 95 o anterior, un formato que Lumina Live no lee. Abrila en un PowerPoint más nuevo y guardala como .pptx.",
    notAPresentation:
      "No se pudo abrir el archivo como presentación: puede estar dañado o no ser una presentación. Probá abrirlo en PowerPoint y guardarlo de nuevo como .pptx.",
  },
  bible: {
    unknownFormat:
      "No se reconoce el formato de «{file}». Se aceptan JSON, Zefania/USFX/OSIS XML y módulos SQLite (MyBible, MySword).",
    zipUnreadable: "El archivo .zip no se pudo leer: {detail}",
    zipEmpty: "El .zip no contiene ningún archivo XML o JSON.",
    sqliteUnreadable: "No se pudo abrir el módulo SQLite: {detail}",
    sqliteNoVerses: "El archivo SQLite no es un módulo de MyBible ni de MySword: no tiene versículos.",
    jsonNoBooks: "El archivo JSON no tiene la forma de una Biblia: no se encontraron sus libros.",
    jsonNoChapters: "El archivo JSON no tiene la forma de una Biblia: no se encontraron sus capítulos.",
    notZefania: "El XML no es una Biblia Zefania: falta el elemento <XMLBIBLE>.",
    notUsfx: "El XML no es una Biblia USFX: falta el elemento <usfx>.",
    notOsis: "El XML no es una Biblia OSIS: falta el elemento <osis>.",
    noVerses: "«{file}» se leyó correctamente pero no contiene ningún versículo.",
    invalidName: "El nombre de la versión no es válido.",
  },
  library: {
    relocateKindMismatch: "El archivo elegido no es del mismo tipo que el original.",
    relocateMissing: "El archivo elegido ya no existe.",
    audioMissing: "El archivo de audio no existe.",
    audioUnsupported: "El archivo elegido no es un audio soportado.",
    folderMissing: "La carpeta no está disponible.",
  },
  programs: {
    notFound: "El programa ya no existe.",
  },
  scenes: {
    invalid: "La escena tiene campos inválidos.",
    invalidName: "El nombre de la escena no es válido.",
  },
  plates: {
    invalid: "La placa tiene campos inválidos.",
    invalidName: "El nombre de la placa no es válido.",
  },
  /** The four time scenes a new install starts with (`DEFAULT_UTILITY_SCENES`),
   *  written once, in the language of that first launch. */
  seed: {
    countdownName: "Cuenta 10 minutos",
    countdownTitle: "El culto comienza en",
    countdownToTimeName: "Comenzamos 10:00",
    countdownToTimeTitle: "Comenzamos a las 10:00",
    clockName: "Reloj",
    stopwatchName: "Cronómetro",
    endMessage: "¡Bienvenidos!",
  },
};

export default es;
export type MainMessages = typeof es;
