"use strict";

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u3000._\-/\\·:：,，;；()（）[\]【】]+/g, "");
}

function entityAliases(entity) {
  return [...new Set([
    entity.name,
    entity.product,
    entity.name && entity.product ? `${entity.name}${entity.product}` : "",
    entity.name && entity.product ? `${entity.name} ${entity.product}` : ""
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function buildEntityDictionary(brief) {
  const source = brief || {};
  return [
    {
      id: "brand",
      type: "brand",
      name: String(source.brand || "").trim(),
      product: String(source.brandProduct || "").trim()
    },
    ...(Array.isArray(source.competitors) ? source.competitors : []).map(
      (item, index) => ({
        id: `competitor_${index + 1}`,
        type: "competitor",
        name: String(item?.name || "").trim(),
        product: String(item?.product || "").trim()
      })
    )
  ].filter((entity) => entity.name || entity.product);
}

function sentenceContaining(answer, alias) {
  const aliasKey = compact(alias);
  if (!aliasKey) return "";
  const sentences = String(answer || "").split(/(?<=[。！？.!?])\s*/);
  return (
    sentences.find((sentence) => compact(sentence).includes(aliasKey)) ||
    String(answer || "")
  );
}

function findEntityMentions(answer, entity) {
  const text = String(answer || "");
  const textKey = compact(text);
  if (!text || !textKey) return [];
  return entityAliases(entity)
    .filter((alias) => textKey.includes(compact(alias)))
    .map((alias) => ({
      entityId: entity.id,
      entityType: entity.type,
      entityName: entity.name,
      product: entity.product,
      surface: alias,
      quote: sentenceContaining(text, alias).slice(0, 500)
    }));
}

function firstMentionPosition(answer, entity) {
  const text = String(answer || "").toLowerCase();
  const positions = entityAliases(entity)
    .map((alias) => text.indexOf(alias.toLowerCase()))
    .filter((position) => position >= 0);
  return positions.length ? Math.min(...positions) : -1;
}

function rankedEntities(answer, dictionary) {
  return (dictionary || [])
    .map((entity, index) => ({
      entity,
      index,
      position: firstMentionPosition(answer, entity)
    }))
    .filter((item) => item.position >= 0)
    .sort((a, b) => a.position - b.position || a.index - b.index);
}

function entityRankById(answer, dictionary, entityId) {
  return (
    rankedEntities(answer, dictionary).findIndex(
      (item) => item.entity.id === entityId
    ) + 1
  );
}

function entityRank(answer, dictionary) {
  return entityRankById(answer, dictionary, "brand");
}

function findEntityMentionsForDictionary(answer, dictionary) {
  return (dictionary || []).flatMap((entity) =>
    findEntityMentions(answer, entity)
  );
}

module.exports = {
  buildEntityDictionary,
  compact,
  entityRank,
  entityRankById,
  entityAliases,
  findEntityMentions,
  findEntityMentionsForDictionary,
  rankedEntities
};
