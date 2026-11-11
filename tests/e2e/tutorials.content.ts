import type { Locale } from "../../src/shared/types/settings";

/**
 * The captions of `npm run tutorials`, per language. `{EN VIVO}` is an app
 * label, written as the Spanish dictionary spells it: the recorder swaps in
 * that language's spelling, in bold. Short sentences, one action each: a
 * caption is on screen for a few seconds over a moving picture.
 */
export type TutorialId = "how-it-works" | "song" | "bible" | "presentation" | "video" | "schedule";

type Captions = Record<string, string>;

export const CAPTIONS: Record<TutorialId, Record<Locale, Captions>> = {
  "how-it-works": {
    es: {
      schedule: "A la izquierda, el programa del culto: lo que vas a proyectar, en orden.",
      preview: "Un clic y queda en la vista previa. Por ahora solo lo ves vos.",
      live: "Tocás {EN VIVO} y pasa al proyector.",
      next: "Mientras tanto, ya podés elegir lo que sigue.",
      arrows: "La flecha → pasa a la estrofa siguiente.",
      verse: "Lo mismo con la lectura.",
      black: "Si algo sale mal, {NEGRO} deja la pantalla en negro.",
      back: "Con {VIVO} vuelve lo que estaba.",
    },
    en: {
      schedule: "On the left is the service schedule: everything you'll show, in order.",
      preview: "Click an item and it opens in the preview. Only you can see it.",
      live: "Click {EN VIVO} and it's on the projector.",
      next: "While that's up, pick what comes next.",
      arrows: "The → key moves to the next verse.",
      verse: "The Scripture reading works the same way.",
      black: "If something goes wrong, {NEGRO} turns the screen black.",
      back: "Click {VIVO} and it all comes back.",
    },
    it: {
      schedule: "A sinistra c’è la scaletta del culto: quello che proietterai, in ordine.",
      preview: "Con un clic finisce in anteprima. Per ora lo vedi solo tu.",
      live: "Premi {EN VIVO} e va sul proiettore.",
      next: "Intanto puoi già scegliere cosa viene dopo.",
      arrows: "Con la freccia → passi alla strofa successiva.",
      verse: "Con la lettura biblica funziona allo stesso modo.",
      black: "Se qualcosa va storto, {NEGRO} manda lo schermo in nero.",
      back: "Con {VIVO} torna quello che c’era.",
    },
    pt: {
      schedule: "À esquerda fica o roteiro do culto: o que vai ser projetado, na ordem.",
      preview: "Com um clique, o item vai para a prévia. Por enquanto só você vê.",
      live: "Clique em {EN VIVO} e ele aparece no projetor.",
      next: "Enquanto isso, já dá para escolher o próximo.",
      arrows: "A seta → passa para a próxima estrofe.",
      verse: "Com a leitura bíblica é igual.",
      black: "Se algo der errado, {NEGRO} deixa a tela preta.",
      back: "Clique em {VIVO} e o conteúdo volta.",
    },
  },
  song: {
    es: {
      tab: "Abrí la pestaña {Canciones}.",
      search: "Escribí parte del título o de la letra. No hace falta poner acentos.",
      pick: "Clic en la canción: sus diapositivas aparecen en la vista previa.",
      live: "Tocás {EN VIVO} y la letra sale en el proyector.",
      arrows: "Con la flecha → pasás a la siguiente.",
      jump: "O hacés clic en la diapositiva que quieras.",
    },
    en: {
      tab: "Open the {Canciones} tab.",
      search: "Type part of the title or the lyrics.",
      pick: "Click the song and its slides show up in the preview.",
      live: "Click {EN VIVO} and the lyrics go up on the projector.",
      arrows: "Press → for the next slide.",
      jump: "Or click any slide to jump straight to it.",
    },
    it: {
      tab: "Apri la scheda {Canciones}.",
      search: "Scrivi una parte del titolo o del testo. Gli accenti non servono.",
      pick: "Clic sul canto: le sue diapositive compaiono in anteprima.",
      live: "Premi {EN VIVO} e il testo va sul proiettore.",
      arrows: "Con la freccia → passi alla successiva.",
      jump: "Oppure fai clic sulla diapositiva che ti serve.",
    },
    pt: {
      tab: "Abra a aba {Canciones}.",
      search: "Digite parte do título ou da letra. Não precisa de acento.",
      pick: "Clique na música e os slides aparecem na prévia.",
      live: "Clique em {EN VIVO} e a letra aparece no projetor.",
      arrows: "A seta → passa para o próximo slide.",
      jump: "Ou clique direto no slide que você quiser.",
    },
  },
  bible: {
    es: {
      tab: "En la pestaña {Biblia}, escribí la cita. Por ejemplo, «{ref}».",
      enter: "Enter, y el versículo queda en la vista previa.",
      live: "Tocás {EN VIVO} y lo ve toda la iglesia.",
      next: "La flecha → muestra el versículo siguiente.",
    },
    en: {
      tab: "In the {Biblia} tab, type the reference. For example, “{ref}”.",
      enter: "Press Enter and the verse lands in the preview.",
      live: "Click {EN VIVO} and the whole church can read it.",
      next: "Press → to show the next verse.",
    },
    it: {
      tab: "Nella scheda {Biblia} scrivi il riferimento. Per esempio «{ref}».",
      enter: "Premi Invio e il versetto va in anteprima.",
      live: "Premi {EN VIVO} e lo vede tutta la chiesa.",
      next: "Con la freccia → mostri il versetto successivo.",
    },
    pt: {
      tab: "Na aba {Biblia}, digite a referência. Por exemplo, “{ref}”.",
      enter: "Aperte Enter e o versículo vai para a prévia.",
      live: "Clique em {EN VIVO} e a igreja toda vê.",
      next: "A seta → mostra o versículo seguinte.",
    },
  },
  presentation: {
    es: {
      tab: "En {Medios}, abrí {Presentaciones}.",
      add: "Con + agregás tu archivo de PowerPoint, un PDF o una presentación de LibreOffice.",
      pick: "Clic en la presentación: las diapositivas aparecen en la vista previa.",
      live: "Tocás {EN VIVO} y sale la primera.",
      arrows: "Avanzás con la flecha → o con el control remoto de presentaciones.",
    },
    en: {
      tab: "In {Medios}, open {Presentaciones}.",
      add: "Click + to add your PowerPoint file, a PDF or a LibreOffice deck.",
      pick: "Click the presentation and its slides show up in the preview.",
      live: "Click {EN VIVO} and the first slide goes up.",
      arrows: "Advance with the → key or a presentation clicker.",
    },
    it: {
      tab: "In {Medios} apri {Presentaciones}.",
      add: "Con + aggiungi il file di PowerPoint, un PDF o una presentazione di LibreOffice.",
      pick: "Clic sulla presentazione: le diapositive compaiono in anteprima.",
      live: "Premi {EN VIVO} e va in onda la prima.",
      arrows: "Vai avanti con la freccia → o con il telecomando per presentazioni.",
    },
    pt: {
      tab: "Em {Medios}, abra {Presentaciones}.",
      add: "No + você adiciona o arquivo do PowerPoint, um PDF ou uma apresentação do LibreOffice.",
      pick: "Clique na apresentação e os slides aparecem na prévia.",
      live: "Clique em {EN VIVO} e o primeiro slide vai para o projetor.",
      arrows: "Avance com a seta → ou com o passador de slides.",
    },
  },
  video: {
    es: {
      tab: "En {Medios}, abrí {Videos}. Con + agregás el archivo.",
      pick: "Un clic y se reproduce en la vista previa, para que lo revises.",
      live: "Tocás {EN VIVO} y arranca en el proyector.",
      black: "Para sacarlo de la pantalla antes del final, {NEGRO}.",
    },
    en: {
      tab: "In {Medios}, open {Videos}. Click + to add the file.",
      pick: "Click it and it plays in the preview, so you can check it first.",
      live: "Click {EN VIVO} and it starts on the projector.",
      black: "To take it off the screen before it ends, click {NEGRO}.",
    },
    it: {
      tab: "In {Medios} apri {Videos}. Con + aggiungi il file.",
      pick: "Con un clic parte in anteprima, così lo controlli.",
      live: "Premi {EN VIVO} e parte sul proiettore.",
      black: "Per toglierlo dallo schermo prima della fine, {NEGRO}.",
    },
    pt: {
      tab: "Em {Medios}, abra {Videos}. No + você adiciona o arquivo.",
      pick: "Com um clique ele toca na prévia, para você conferir.",
      live: "Clique em {EN VIVO} e ele começa no projetor.",
      black: "Para tirar da tela antes do fim, clique em {NEGRO}.",
    },
  },
  schedule: {
    es: {
      song: "Armá el programa antes del culto. Elegí un himno en {Canciones} y tocá {Agregar}.",
      verse: "Lo mismo con la lectura, desde {Biblia}.",
      video: "Desde {Medios} también podés arrastrar un video o una imagen al programa.",
      save: "Lo guardás con un nombre.",
      reopen: "Cuando llega el culto, lo abrís y está todo en su lugar.",
      run: "En el culto, vas elemento por elemento con {EN VIVO}.",
    },
    en: {
      song: "Build the schedule before the service. Pick a hymn in {Canciones} and click {Agregar}.",
      verse: "Do the same with the reading, from {Biblia}.",
      video: "From {Medios}, you can also drag a video or an image onto the schedule.",
      save: "Save it with a name.",
      reopen: "When it's time for the service, open it and everything is where you left it.",
      run: "During the service, go item by item with {EN VIVO}.",
    },
    it: {
      song: "Prepara la scaletta prima del culto. Scegli un inno in {Canciones} e premi {Agregar}.",
      verse: "Lo stesso con la lettura, da {Biblia}.",
      video: "Da {Medios} puoi anche trascinare un video o un’immagine nella scaletta.",
      save: "La salvi con un nome.",
      reopen: "Quando arriva il culto, la riapri e trovi tutto al suo posto.",
      run: "Durante il culto vai avanti una voce alla volta con {EN VIVO}.",
    },
    pt: {
      song: "Monte o roteiro antes do culto. Escolha um hino em {Canciones} e clique em {Agregar}.",
      verse: "Faça o mesmo com a leitura, na {Biblia}.",
      video: "Em {Medios}, você também pode arrastar um vídeo ou uma imagem para o roteiro.",
      save: "Salve com um nome.",
      reopen: "Na hora do culto, é só abrir de novo e está tudo no lugar.",
      run: "No culto, vá item por item com {EN VIVO}.",
    },
  },
};

/** The verse each language looks up in the Bible tutorial, as typed. */
export const REFERENCE: Record<Locale, string> = { es: "Juan 3 16", en: "John 3 16", it: "Giovanni 3 16", pt: "João 3 16" };
