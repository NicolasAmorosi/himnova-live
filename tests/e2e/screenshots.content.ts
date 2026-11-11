import type { Locale } from "../../src/shared/types/settings";

/**
 * What the screenshots show, per language (`screenshots.capture.ts`). Every
 * text is copied from a printed source (named above it), never written from
 * memory: the hymns in each language's own old translation, the psalm from a
 * public-domain Bible that language's churches read. Two translations of Ein
 * feste Burg (it, pt) are 19th-century but their translators' death years are
 * unknown, so their public-domain status outside the US is likely, not proven.
 * Changing a text means checking it against a source again.
 */

export type Hymn = { title: string; credit: string; stanzas: string[][] };
type TitleSlide = { title: string; credit: string };

export type Content = {
  /** The library's file names, without extension, by the file they copy
   *  (`raw/<key>.*`). The backgrounds are the app's own (the starter look). */
  files: Record<"announcements" | "welcome" | "offering" | "testimony" | "track", string>;
  /** Heber's «Holy, Holy, Holy»: four stanzas of four lines. */
  holy: Hymn;
  /** Luther's «Ein feste Burg»: two stanzas of nine lines. */
  fortress: Hymn;
  decks: { announcements: { name: string; slides: TitleSlide[] }; sermon: { name: string; slides: TitleSlide[] } };
  program: string;
  copyright: string;
  /** Imported and made the default; `null` is the bundled RV1909. Only Psalm
   *  23 is imported: it is all the screenshots open. */
  bible: { name: string; psalms: string; psalm23: string[] } | null;
  /** The start of Psalm 23:6, the verse that goes live. */
  verse: string;
};

export const CONTENT: Record<Locale, Content> = {
  es: {
    files: {
      announcements: "Anuncios",
      welcome: "Bienvenida",
      offering: "Música de ofrenda",
      testimony: "Testimonio",
      track: "Pista instrumental",
    },
    holy: {
      title: "Santo, santo, santo",
      credit: "Reginald Heber · trad. Juan B. Cabrera",
      stanzas: [
        ["¡Santo! ¡Santo! ¡Santo! Señor omnipotente,", "siempre el labio mío loores te dará;", "¡Santo! ¡Santo! ¡Santo! te adoro reverente,", "Dios en tres Personas, bendita Trinidad."],
        ["¡Santo! ¡Santo! ¡Santo! en numeroso coro,", "santos escogidos te adoran sin cesar,", "de alegría llenos, y sus coronas de oro", "rinden ante el trono y el cristalino mar."],
        ["¡Santo! ¡Santo! ¡Santo! la inmensa muchedumbre", "de ángeles que cumplen tu santa voluntad,", "ante ti se postra bañada de tu lumbre,", "ante ti que has sido, que eres y serás."],
        ["¡Santo! ¡Santo! ¡Santo! por más que estés velado,", "e imposible sea tu gloria contemplar,", "santo tú eres solo, y nada hay a tu lado", "en poder perfecto, pureza y caridad."],
      ],
    },
    fortress: {
      title: "Castillo fuerte",
      credit: "Martín Lutero · trad. Juan B. Cabrera",
      stanzas: [
        ["Castillo fuerte es nuestro Dios,", "defensa y buen escudo.", "Con su poder nos librará", "en este trance agudo.", "Con furia y con afán", "acósanos Satán:", "por armas deja ver", "astucia y gran poder;", "cual él no hay en la tierra."],
        ["Nuestro valor es nada aquí,", "con él todo es perdido;", "mas con nosotros luchará", "de Dios el escogido.", "Es nuestro Rey Jesús,", "el que venció en la cruz,", "Señor y Salvador,", "y siendo él solo Dios,", "él triunfa en la batalla."],
      ],
    },
    decks: {
      announcements: {
        name: "Anuncios de la semana",
        slides: [
          { title: "Anuncios", credit: "Esta semana en la iglesia" },
          { title: "Reunión de jóvenes", credit: "18:00 · Salón principal" },
          { title: "Cena de camaradería", credit: "20:30 · Traé algo para compartir" },
        ],
      },
      sermon: {
        name: "Bosquejo del sermón",
        slides: [
          { title: "El Señor es mi pastor", credit: "Salmo 23" },
          { title: "1. Él me guía", credit: "«Junto á aguas de reposo me pastoreará» (v. 2)" },
          { title: "2. Él me acompaña", credit: "«Porque tú estarás conmigo» (v. 4)" },
        ],
      },
    },
    program: "Culto de adoración",
    copyright: "Dominio público",
    bible: null,
    verse: "Ciertamente el bien y la misericordia me seguirán",
  },

  en: {
    files: {
      announcements: "Announcements",
      welcome: "Welcome",
      offering: "Offering music",
      testimony: "Testimony",
      track: "Instrumental track",
    },
    holy: {
      title: "Holy, Holy, Holy",
      credit: "Reginald Heber",
      // Heber, «Hymns, written and adapted to the weekly church service of the year», 1827, pp. 11–12.
      stanzas: [
        ["Holy, holy, holy, Lord God Almighty!", "Early in the morning our song shall rise to Thee;", "Holy, holy, holy! merciful and mighty!", "God in three persons, blessed Trinity!"],
        ["Holy, holy, holy! all the saints adore Thee,", "Casting down their golden crowns around the glassy sea;", "Cherubim and seraphim falling down before Thee,", "Which wert and art and evermore shalt be!"],
        ["Holy, holy, holy! Though the darkness hide Thee,", "Though the eye of sinful man Thy glory may not see,", "Only Thou art holy, there is none beside Thee,", "Perfect in power, in love, and purity!"],
        ["Holy, holy, holy, Lord God Almighty!", "All Thy works shall praise Thy name in earth and sky and sea.", "Holy, holy, holy! merciful and mighty!", "God in three persons, blessed Trinity!"],
      ],
    },
    fortress: {
      title: "A Mighty Fortress",
      credit: "Martin Luther · trans. Frederic H. Hedge",
      // «Luther's Psalm», «Hymns for the Church of Christ», Boston, 1853, hymn 852.
      stanzas: [
        ["A mighty fortress is our God,", "A bulwark never failing;", "Our helper he amid the flood", "Of mortal ills prevailing.", "For still our ancient foe", "Doth seek to work us woe,", "His craft and power are great,", "And, armed with cruel hate,", "On earth is not his equal."],
        ["Did we in our own strength confide,", "Our striving would be losing, —", "Were not the right man on our side,", "The man of God's own choosing.", "Dost ask who that may be?", "Christ Jesus, it is he,", "Lord Sabaoth his name,", "From age to age the same,", "And he must win the battle."],
      ],
    },
    decks: {
      announcements: {
        name: "This week's announcements",
        slides: [
          { title: "Announcements", credit: "This week at church" },
          { title: "Youth meeting", credit: "6:00 pm · Main hall" },
          { title: "Fellowship dinner", credit: "8:30 pm · Bring something to share" },
        ],
      },
      sermon: {
        name: "Sermon outline",
        slides: [
          { title: "The Lord is my shepherd", credit: "Psalm 23" },
          { title: "1. He leads me", credit: '"He leadeth me beside the still waters" (v. 2)' },
          { title: "2. He is with me", credit: '"For thou art with me" (v. 4)' },
        ],
      },
    },
    program: "Worship service",
    copyright: "Public domain",
    // eBible.org/eng-kjv, checked against Project Gutenberg's KJV.
    bible: {
      name: "King James Version",
      psalms: "Psalms",
      psalm23: [
        "The LORD is my shepherd; I shall not want.",
        "He maketh me to lie down in green pastures: he leadeth me beside the still waters.",
        "He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.",
        "Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me; thy rod and thy staff they comfort me.",
        "Thou preparest a table before me in the presence of mine enemies: thou anointest my head with oil; my cup runneth over.",
        "Surely goodness and mercy shall follow me all the days of my life: and I will dwell in the house of the LORD for ever.",
      ],
    },
    verse: "Surely goodness and mercy shall follow me",
  },
  it: {
    files: {
      announcements: "Annunci",
      welcome: "Benvenuto",
      offering: "Musica dell'offerta",
      testimony: "Testimonianza",
      track: "Traccia strumentale",
    },
    holy: {
      title: "Santo, Santo, Santo",
      credit: "Reginald Heber · trad. A. Pirazzini",
      // «Il Nuovo Innario Evangelico», New York, 1907, no. 28. Agide Pirazzini died in 1934.
      stanzas: [
        ["Santo, Santo, Santo,", "Signore onnipossente,", "Dallo spuntar del giorno", "S' esalti tua bontà!", "Santo, Santo, Santo,", "Dolcissimo, e clemente,", "Dio solo in tre persone", "Beäta Trinità!"],
        ["Santo, Santo, Santo,", "Cantano a te i redenti", "E lor corone t' offron", "Lodando tua maestà.", "Cherùbi e Serafini", "Prostransi a te, plaudenti,", "Che fosti, sei, saraï", "Per tutta eternità."],
        ["Santo, Santo, Santo,", "T' avvolge il tenebrore,", "Nè l' occhio del malvagio", "Tua gloria può mirar.", "Tu sol sei puro e santo", "Perfetto, pien d' amore,", "Onnipossente e giusto", "E mai non puoi cangiar."],
        ["Santo, Santo, Santo,", "Signore onnipossente,", "Ti lodin l' opre tue", "Per tutta eternità.", "Santo, Santo, Santo,", "Dolcissimo, e clemente,", "Dio solo in tre persone", "Beäta Trinità!"],
      ],
    },
    fortress: {
      title: "Forte Rocca",
      credit: "Martin Lutero · trad. G. Niccolini",
      // «Il Nuovo Innario Evangelico», New York, 1907, no. 38; first printed unsigned in «Inni e cantici», Roma,
      // 1897. Public domain in the US; the translator's death year is unknown.
      stanzas: [
        ["Forte Rocca è il nostro Dio;", "Nostra speme in Lui si fonda;", "Ne sostien benigno e pio", "Nell' angoscia più profonda.", "Il tristo tentator", "A noi fa guerra ognor;", "Astuzia e frode", "Son l' armi sue tremende,", "Ma da lor Dio ne difende."],
        ["È perduto immantinente", "Quei che solo in sè confida;", "Per noi pugna un Uom possente", "Che Dio scelse a nostra guida.", "Chi sia, domandi tu?", "Egli è Cristo Gesù,", "Nostro Signore;", "Da Lui vigor ne viene,", "La vittoria in mano Ei tiene."],
      ],
    },
    decks: {
      announcements: {
        name: "Avvisi della settimana",
        slides: [
          { title: "Avvisi", credit: "Questa settimana in chiesa" },
          { title: "Incontro dei giovani", credit: "18:00 · Salone principale" },
          { title: "Cena fraterna", credit: "20:30 · Porta qualcosa da condividere" },
        ],
      },
      sermon: {
        name: "Schema del sermone",
        slides: [
          { title: "L'Eterno è il mio pastore", credit: "Salmo 23" },
          { title: "1. Egli mi guida", credit: "«mi guida lungo le acque chete» (v. 2)" },
          { title: "2. Egli è con me", credit: "«perché tu sei meco» (v. 4)" },
        ],
      },
    },
    program: "Culto di adorazione",
    copyright: "Pubblico dominio",
    // Giovanni Luzzi's Riveduta, 1927 (he died in 1948): eBible.org/ita1927, checked against laparola.net.
    // Verse 1 without its «Salmo di Davide.» superscription, like the other languages.
    bible: {
      name: "Riveduta 1927",
      psalms: "Salmi",
      psalm23: [
        "L’Eterno è il mio pastore, nulla mi mancherà.",
        "Egli mi fa giacere in verdeggianti paschi, mi guida lungo le acque chete.",
        "Egli mi ristora l’anima, mi conduce per sentieri di giustizia, per amor del suo nome.",
        "Quand’anche camminassi nella valle dell’ombra della morte, io non temerei male alcuno, perché tu sei meco; il tuo bastone e la tua verga son quelli che mi consolano.",
        "Tu apparecchi davanti a me la mensa al cospetto dei miei nemici; tu ungi il mio capo con olio; la mia coppa trabocca.",
        "Certo, beni e benignità m’accompagneranno tutti i giorni della mia vita; ed io abiterò nella casa dell’Eterno per lunghi giorni.",
      ],
    },
    verse: "Certo, beni e benignità m’accompagneranno",
  },

  pt: {
    files: {
      announcements: "Avisos",
      welcome: "Boas-vindas",
      offering: "Música da oferta",
      testimony: "Testemunho",
      track: "Faixa instrumental",
    },
    holy: {
      title: "Santo! Santo! Santo!",
      credit: "Reginald Heber · trad. João G. da Rocha",
      // «Salmos e Hinos», 1959 printing, no. 221, signed «J. G. R.» (1888). João Gomes da Rocha died in 1947.
      stanzas: [
        ["Santo! Santo! Santo! Deus onipotente!", "Cedo de manhã cantaremos Teu louvor:", "Santo! Santo! Santo! Jeová triuno!", "E's um só Deus, excelso, Criador."],
        ["Santo! Santo! Santo! todos os remidos,", "Juntos com os anjos, proclamam Teu louvor:", "Antes de formar-se o firmamento e a terra,", "Eras; e sempre és, e has de ser, Senhor."],
        ["Santo! Santo! Santo! nós os pecadores", "Não podemos ver Tua gloria sem tremor:", "Tu somente és santo; não ha nenhum outro", "Perfeito em pureza, poder, e amor."],
        ["Santo! Santo! Santo! Deus onipotente!", "Tuas obras louvarão Teu nome com fervor:", "Santo! Santo! Santo! justo e compassivo!", "E's um só Deus, supremo, Criador!"],
      ],
    },
    fortress: {
      title: "Castelo forte",
      credit: "Martinho Lutero · trad. J. E. von Hafe",
      // «Salmos e Hinos», 1959 printing, no. 369, signed «J. E. von H.» (1886). The translator's death year is
      // unknown.
      stanzas: [
        ["Castelo forte é nosso Deus,", "Espada e bom escudo;", "Com Seu poder defende os seus,", "Em todo o transe agudo.", "Com fúria pertinaz,", "Persegue Satanás", "Com ânimo cruel:", "Astuto e forte é êle,", "Igual não há na terra."],
        ["A nossa fôrça nada faz;", "O homem 'stá perdido;", "Mas nosso Deus socorro traz,", "No Filho escolhido.", "Sabeis quem é? Jesus,", "O que venceu na cruz,", "Senhor dos altos céus;", "E sendo o próprio Deus,", "Triunfa na batalha."],
      ],
    },
    decks: {
      announcements: {
        name: "Avisos da semana",
        slides: [
          { title: "Avisos", credit: "Esta semana na igreja" },
          { title: "Reunião de jovens", credit: "18:00 · Salão principal" },
          { title: "Jantar de confraternização", credit: "20:30 · Traga algo para compartilhar" },
        ],
      },
      sermon: {
        name: "Esboço do sermão",
        slides: [
          { title: "O Senhor é o meu pastor", credit: "Salmo 23" },
          { title: "1. Ele me guia", credit: '"guia-me mansamente a aguas mui quietas" (v. 2)' },
          { title: "2. Ele está comigo", credit: '"porque tu estás comigo" (v. 4)' },
        ],
      },
    },
    program: "Culto de adoração",
    copyright: "Domínio público",
    // João Ferreira de Almeida, Revista e Corrigida, 1911 reprint: CrossWire's PorAlmeida1911, checked word for
    // word against the American Bible Society's 1904 printing (archive.org). Its own spelling (valle, oleo, calix).
    bible: {
      name: "Almeida 1911",
      psalms: "Salmos",
      psalm23: [
        "O Senhor é o meu pastor, nada me faltará.",
        "Deitar-me faz em verdes pastos, guia-me mansamente a aguas mui quietas.",
        "Refrigera a minha alma; guia-me pelas veredas da justiça, por amor do seu nome.",
        "Ainda que eu andasse pelo valle da sombra da morte, não temeria mal algum, porque tu estás comigo; a tua vara e o teu cajado me consolam.",
        "Preparas uma mesa perante mim na presença dos meus inimigos, unges a minha cabeça com oleo, o meu calix trasborda.",
        "Certamente que a bondade e a misericordia me seguirão todos os dias da minha vida: e habitarei na casa do Senhor por longos dias.",
      ],
    },
    verse: "Certamente que a bondade e a misericordia me seguirão",
  },
};
