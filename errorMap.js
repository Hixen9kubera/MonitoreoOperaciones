// Clasificacion de errores de publicacion en MercadoLibre.
// Cada patron mapea a un tipo legible y a una instruccion de "como corregirlo".
// El orden importa: el primer patron que coincide gana.

const REGLAS = [
  {
    test: /GRID_REQUERIDO|guia de tallas|gu.a de tallas/i,
    tipo: "Guía de tallas requerida",
    comoCorregir:
      "La categoría exige una guía de tallas (grid). Configura la guía de tallas del producto en MercadoLibre y vuelve a publicar.",
    severidad: "config",
  },
  {
    test: /ME1_INACTIVO|Mercado Env.os 1|ME1/i,
    tipo: "Mercado Envíos 1 inactivo",
    comoCorregir:
      "La cuenta no tiene activo Mercado Envíos 1 (ME1). Actívalo en el dashboard de MercadoLibre de la cuenta y vuelve a publicar.",
    severidad: "config",
  },
  {
    test: /NEEDS_MANUAL_CONFIG/i,
    tipo: "Configuración manual requerida",
    comoCorregir:
      "MercadoLibre requiere una configuración manual en el dashboard de la cuenta antes de publicar. Revisa el detalle del mensaje para saber qué activar.",
    severidad: "config",
  },
  {
    test: /GTIN_INVALIDO|c.digo de barras/i,
    tipo: "GTIN / código de barras inválido",
    comoCorregir:
      "El producto necesita un código de barras (GTIN/EAN/UPC) real. Asigna el GTIN correcto en el producto o solicita la excepción de marca a MercadoLibre.",
    severidad: "config",
  },
  {
    test: /403.*Forbidden|Forbidden.*403/i,
    tipo: "Imágenes bloqueadas (403)",
    comoCorregir:
      "Las imágenes no se pudieron descargar desde WordPress (403 Forbidden). Revisa el hotlinking / permisos de chunche.shop o vuelve a subir las imágenes.",
    severidad: "imagen",
  },
  {
    test: /429|Too Many Requests/i,
    tipo: "Límite de descargas (429)",
    comoCorregir:
      "Se alcanzó el límite de peticiones al descargar imágenes (429). Reintenta más tarde con throttling; no es un error permanente.",
    severidad: "imagen",
  },
  {
    test: /sin imagen en la respuesta|IMAGE_OTHER|GEMINI_ERROR/i,
    tipo: "Generación de imagen falló (Gemini)",
    comoCorregir:
      "El modelo de imágenes (Gemini) no devolvió imagen válida. Reintenta la generación; si persiste, sube una imagen manual para ese SKU.",
    severidad: "imagen",
  },
  {
    test: /401|invalid access token|token/i,
    tipo: "Token de MercadoLibre expirado (401)",
    comoCorregir:
      "El access token de la cuenta expiró. Refresca el token de la cuenta (BEKURA / SANCORFASHION) y reintenta la publicación.",
    severidad: "auth",
  },
  {
    test: /400.*Validation error|Validation error/i,
    tipo: "Error de validación (HTTP 400)",
    comoCorregir:
      "Faltan atributos obligatorios o hay valores inválidos para la ficha técnica de la categoría. Completa los atributos requeridos (marca, modelo, ficha técnica) y vuelve a publicar.",
    severidad: "validacion",
  },
  {
    test: /Traceback|Exception|Error:/i,
    tipo: "Error interno del proceso",
    comoCorregir:
      "Ocurrió una excepción interna durante la publicación. Revisa los logs del pipeline para ese SKU y reintenta.",
    severidad: "interno",
  },
];

export function clasificarError(errorTexto) {
  const txt = (errorTexto || "").trim();
  if (!txt) {
    return {
      tipo: "Sin detalle de error",
      comoCorregir: "No se registró un mensaje de error. Revisa el log del pipeline para este SKU.",
      severidad: "desconocido",
    };
  }
  for (const r of REGLAS) {
    if (r.test.test(txt)) {
      return { tipo: r.tipo, comoCorregir: r.comoCorregir, severidad: r.severidad };
    }
  }
  return {
    tipo: "Otro error",
    comoCorregir: "Error no catalogado. Revisa el mensaje completo y los logs del pipeline.",
    severidad: "otro",
  };
}
