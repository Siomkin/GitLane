import { describe, expect, it } from "vitest";
import { groupTrailers, parsePersonTrailers, uniqueTrailerPeople } from "./commitTrailers";

const BODY = [
  "Explain the change.",
  "",
  "Co-authored-by: Marta Kowalska <marta.kowalska@e-medicus.ch>",
  "co-AUTHORED-by: Jonas Deri <jonas.deri@e-medicus.ch>",
  "Signed-off-by: Jane Doe <jane@example.com>",
  "Reviewed-by: Marta Kowalska <marta.kowalska@e-medicus.ch>",
  "Tested-by: Bob Jones <bob@example.com>",
  "Reviewed-and-tested-by: Ada Lovelace <ada@example.com>",
  "Cc: Carol <carol@example.com>",
].join("\n");

describe("parsePersonTrailers", () => {
  it("parses the common person trailers with normalized keys", () => {
    expect(parsePersonTrailers(BODY).map((trailer) => trailer.key)).toEqual([
      "Co-authored-by",
      "Co-authored-by",
      "Signed-off-by",
      "Reviewed-by",
      "Tested-by",
      "Reviewed-and-tested-by",
      "Cc",
    ]);
  });

  it("captures name and email", () => {
    expect(parsePersonTrailers("Signed-off-by: Jane Doe <jane@example.com>")).toEqual([
      { key: "Signed-off-by", name: "Jane Doe", email: "jane@example.com" },
    ]);
  });

  it("finds trailers even when prose follows them", () => {
    const body = "Co-authored-by: Jane Doe <jane@example.com>\n\nMore notes after.";
    expect(parsePersonTrailers(body)).toHaveLength(1);
  });

  it("ignores non-person trailers and non-trailer lines", () => {
    const body = [
      "Fixes: #123",
      "See-also: 8049a668 (some commit)",
      "Change-Id: I8badf00d",
      "not a trailer <jane@example.com>",
      "Co-authored-by: missing email",
    ].join("\n");
    expect(parsePersonTrailers(body)).toEqual([]);
  });

  it("rejects a nameless trailer rather than surfacing a blank person", () => {
    expect(parsePersonTrailers("Co-authored-by: <jane@example.com>")).toEqual([]);
    expect(parsePersonTrailers("Co-authored-by:    <jane@example.com>")).toEqual([]);
  });
});

describe("groupTrailers", () => {
  it("groups by role in first-appearance order and dedupes people per group", () => {
    const groups = groupTrailers(
      parsePersonTrailers(
        [
          "Co-authored-by: Jane Doe <jane@example.com>",
          "Co-authored-by: Jane Doe <JANE@example.com>",
          "Reviewed-by: Bob Jones <bob@example.com>",
          "Co-authored-by: Ada Lovelace <ada@example.com>",
        ].join("\n"),
      ),
    );
    expect(groups.map((group) => group.key)).toEqual(["Co-authored-by", "Reviewed-by"]);
    expect(groups[0].people.map((person) => person.name)).toEqual(["Jane Doe", "Ada Lovelace"]);
  });
});

describe("uniqueTrailerPeople", () => {
  it("flattens to unique people and can exclude the commit author", () => {
    const trailers = parsePersonTrailers(BODY);
    const all = uniqueTrailerPeople(trailers);
    expect(all.map((person) => person.name)).toEqual([
      "Marta Kowalska",
      "Jonas Deri",
      "Jane Doe",
      "Bob Jones",
      "Ada Lovelace",
      "Carol",
    ]);
    const withoutAuthor = uniqueTrailerPeople(trailers, "MARTA.KOWALSKA@e-medicus.ch");
    expect(withoutAuthor.map((person) => person.name)).not.toContain("Marta Kowalska");
  });
});
