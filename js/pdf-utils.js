/* ============================================================
   PDF EXPORT UTILITIES
   Shared by admin.html, staff.html and student.html for every
   "Download PDF" button: student/staff lists, the classes &
   subjects list, scores/subject reports, and individual report
   cards.

   Built on jsPDF + jspdf-autotable, loaded via CDN just before
   this file on each page (see the <script> tags near the bottom
   of admin.html / staff.html / student.html). Nothing here talks
   to Appwrite directly — callers gather the data (from their own
   cache or a fresh query) and pass plain objects/arrays in, which
   keeps this file reusable across all three dashboards.
   ============================================================ */

const PDF_BRAND_GREEN = [43, 86, 70]; // matches the site's forest-800
const PDF_BRAND_GRAY = [110, 110, 110];
const PDF_MARGIN = 40;

function pdfLibsReady() {
  return typeof window.jspdf !== "undefined" && typeof window.jspdf.jsPDF === "function";
}

function newPdfDoc() {
  if (!pdfLibsReady()) {
    throw new Error("PDF library didn't load. Check your connection and try again.");
  }
  const { jsPDF } = window.jspdf;
  return new jsPDF({ unit: "pt", format: "a4" });
}

/** Draws the shared letterhead (school name, doc title, subtitle,
 * generated-on stamp, rule line) and returns the y-coordinate
 * content should start at. */
function pdfHeader(doc, title, subtitle) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const schoolName = (typeof POCKETBASE_CONFIG !== "undefined" && POCKETBASE_CONFIG.schoolName) || "School";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...PDF_BRAND_GREEN);
  doc.text(schoolName, PDF_MARGIN, 46);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...PDF_BRAND_GRAY);
  doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth - PDF_MARGIN, 46, { align: "right" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.setTextColor(20, 20, 20);
  doc.text(title, PDF_MARGIN, 70);

  let y = 88;
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text(subtitle, PDF_MARGIN, 86);
    y = 98;
  }

  doc.setDrawColor(...PDF_BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(PDF_MARGIN, y, pageWidth - PDF_MARGIN, y);

  return y + 20;
}

/** Stamps "<School> · Page X of Y" at the bottom of every page.
 * Call once, right before doc.save(), so the total page count is
 * already final. */
function pdfFooter(doc) {
  const schoolName = (typeof POCKETBASE_CONFIG !== "undefined" && POCKETBASE_CONFIG.schoolName) || "School";
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text(`${schoolName} · Page ${i} of ${pageCount}`, pageWidth / 2, pageHeight - 24, { align: "center" });
  }
}

function savePdf(doc, filename) {
  pdfFooter(doc);
  doc.save(filename);
}

/** Turns arbitrary text into a safe PDF filename fragment. */
function pdfSafeName(str) {
  return String(str || "").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "file";
}

const PDF_TABLE_STYLE = {
  styles: { fontSize: 8.5, cellPadding: 5.5, textColor: [30, 30, 30] },
  headStyles: { fillColor: PDF_BRAND_GREEN, textColor: 255, fontStyle: "bold" },
  alternateRowStyles: { fillColor: [244, 248, 246] },
  margin: { left: PDF_MARGIN, right: PDF_MARGIN },
};

/* ---------- Students list ---------- */
function downloadStudentsListPdf(students, { subtitle = "" } = {}) {
  if (typeof toast === "function" && (!students || students.length === 0)) {
    toast("No students to export.", "error");
    return;
  }
  const doc = newPdfDoc();
  const count = students.length;
  const startY = pdfHeader(doc, "Student List", subtitle || `${count} student${count === 1 ? "" : "s"}`);

  doc.autoTable({
    startY,
    ...PDF_TABLE_STYLE,
    head: [["Name", "School ID", "Class", "Arm", "Department", "Guardian", "Guardian phone"]],
    body: students.map((s) => [
      s.full_name || "—",
      s.school_id || "—",
      s.class_name || "—",
      s.arm || "—",
      s.department || "—",
      s.guardian_name || "—",
      s.guardian_phone || "—",
    ]),
  });

  savePdf(doc, `students-list-${pdfSafeName(new Date().toISOString().slice(0, 10))}.pdf`);
}

/* ---------- Staff list ---------- */
function downloadStaffListPdf(staffList) {
  if (typeof toast === "function" && (!staffList || staffList.length === 0)) {
    toast("No staff to export.", "error");
    return;
  }
  const doc = newPdfDoc();
  const count = staffList.length;
  const startY = pdfHeader(doc, "Staff List", `${count} staff member${count === 1 ? "" : "s"}`);

  doc.autoTable({
    startY,
    ...PDF_TABLE_STYLE,
    head: [["Name", "School ID", "Position", "Classes", "Subjects"]],
    body: staffList.map((s) => [
      s.full_name || "—",
      s.school_id || "—",
      s.position || "—",
      (s.classes || []).join(", ") || "—",
      (s.subjects || []).join(", ") || "—",
    ]),
  });

  savePdf(doc, `staff-list-${pdfSafeName(new Date().toISOString().slice(0, 10))}.pdf`);
}

/* ---------- Classes & subjects ---------- */
function downloadClassesPdf(classes) {
  if (typeof toast === "function" && (!classes || classes.length === 0)) {
    toast("No classes to export.", "error");
    return;
  }
  const doc = newPdfDoc();
  const count = classes.length;
  const startY = pdfHeader(doc, "Classes & Subjects", `${count} class${count === 1 ? "" : "es"}`);

  doc.autoTable({
    startY,
    ...PDF_TABLE_STYLE,
    head: [["Class", "Arms", "Departments", "Subjects"]],
    body: classes.map((c) => [
      c.name || "—",
      (c.arms || []).join(", ") || "—",
      (c.departments || []).join(", ") || "—",
      (c.subjects || []).join(", ") || "—",
    ]),
  });

  savePdf(doc, `classes-subjects.pdf`);
}

/* ---------- Scores / subject report (admin Scores tab, staff entry sheet) ---------- */
function downloadScoresPdf(scores, { className = "", subject = "", term = "" } = {}) {
  if (typeof toast === "function" && (!scores || scores.length === 0)) {
    toast("No scores to export.", "error");
    return;
  }
  const doc = newPdfDoc();
  const subtitle = [className, subject, term].filter(Boolean).join(" · ") || `${scores.length} record(s)`;
  const startY = pdfHeader(doc, "Scores Report", subtitle);

  doc.autoTable({
    startY,
    ...PDF_TABLE_STYLE,
    head: [["Student", "CA1", "CA2", "Exam", "Total", "Grade", "Position"]],
    body: scores.map((r) => [
      r.student_name || r.student_id || "—",
      r.ca1 ?? "—",
      r.ca2 ?? "—",
      r.exam ?? "—",
      r.total ?? "—",
      r.grade ?? "—",
      r.position ?? "—",
    ]),
  });

  savePdf(doc, `scores-${pdfSafeName([className, subject, term].filter(Boolean).join("-")) || "report"}.pdf`);
}

/* ---------- Individual report card ---------- */

/** One term's worth of scores + remarks, laid out as a labelled
 * block: subject table, total/average line, then teacher's and
 * admin's remarks (taken from whichever score row has them). Used
 * both for a single-term report card and as one section of a
 * multi-term one. Returns the y-coordinate after everything drawn. */
function drawReportTermSection(doc, y, termLabel, termScores) {
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...PDF_BRAND_GREEN);
  doc.text(termLabel, PDF_MARGIN, y);
  y += 14;

  if (!termScores || termScores.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9.5);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text("No scores published for this term yet.", PDF_MARGIN, y);
    return y + 20;
  }

  doc.autoTable({
    startY: y,
    ...PDF_TABLE_STYLE,
    styles: { ...PDF_TABLE_STYLE.styles, fontSize: 9 },
    head: [["Subject", "CA1", "CA2", "Exam", "Total", "Grade", "Position"]],
    body: termScores.map((r) => [
      r.subject || "—",
      r.ca1 ?? "—",
      r.ca2 ?? "—",
      r.exam ?? "—",
      r.total ?? "—",
      r.grade ?? "—",
      r.position ?? "—",
    ]),
  });

  y = doc.lastAutoTable.finalY + 18;

  const totalScore = termScores.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  const average = (totalScore / termScores.length).toFixed(1);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(20, 20, 20);
  doc.text(`Total: ${totalScore}     Average: ${average}`, PDF_MARGIN, y);
  y += 18;

  const remarkDoc = termScores.find((r) => r.teacher_remark || r.admin_remark);
  if (remarkDoc && (remarkDoc.teacher_remark || remarkDoc.admin_remark)) {
    const wrapWidth = pageWidth - PDF_MARGIN * 2;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text("Teacher's remark:", PDF_MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20, 20, 20);
    const teacherLines = doc.splitTextToSize(remarkDoc.teacher_remark || "—", wrapWidth - 110);
    doc.text(teacherLines, PDF_MARGIN + 110, y);
    y += Math.max(12, teacherLines.length * 12) + 8;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text("Admin's remark:", PDF_MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20, 20, 20);
    const adminLines = doc.splitTextToSize(remarkDoc.admin_remark || "—", wrapWidth - 110);
    doc.text(adminLines, PDF_MARGIN + 110, y);
    y += Math.max(12, adminLines.length * 12) + 14;
  } else {
    y += 8;
  }

  return y;
}

/** Draws the student identity block (name, ID, class/arm/dept)
 * shared by both report-card variants below. */
function drawReportCardIdentity(doc, y, profile) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(20, 20, 20);
  doc.text(profile.full_name || "—", PDF_MARGIN, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...PDF_BRAND_GRAY);
  const metaLine = [
    `ID: ${profile.school_id || "—"}`,
    `Class: ${profile.class_name || "—"}${profile.arm ? " (" + profile.arm + ")" : ""}`,
    profile.department ? `Dept: ${profile.department}` : null,
  ].filter(Boolean).join("   ·   ");
  doc.text(metaLine, PDF_MARGIN, y);
  return y + 22;
}

/** Single-term report card — used by the student's own "Download
 * PDF" button (their currently selected term) and by admin/staff
 * downloading one specific term for one student. */
function downloadReportCardPdf(profile, scores, { term = "", session = "" } = {}) {
  const doc = newPdfDoc();
  let y = pdfHeader(doc, "Student Report Card", [term, session].filter(Boolean).join(" · "));
  y = drawReportCardIdentity(doc, y, profile);
  drawReportTermSection(doc, y, term || "Scores", scores);

  savePdf(doc, `report-card-${pdfSafeName(profile.school_id || profile.full_name)}-${pdfSafeName(term || "term")}.pdf`);
}

/** Full/cumulative report card — every term that has at least one
 * score on record for this student, each as its own section on the
 * same document. This is what admin's and staff's per-student
 * "Report" download produces, since they aren't tied to whichever
 * term happens to be selected in a dropdown. `allScores` is the
 * student's complete scores list (any term), unfiltered. */
function downloadFullReportCardPdf(profile, allScores, { session = "" } = {}) {
  const doc = newPdfDoc();
  let y = pdfHeader(doc, "Student Report Card", session || "All terms on record");
  y = drawReportCardIdentity(doc, y, profile);

  const byTerm = new Map();
  (allScores || []).forEach((r) => {
    const key = r.term || "Unspecified term";
    if (!byTerm.has(key)) byTerm.set(key, []);
    byTerm.get(key).push(r);
  });

  const termOrder = ["First Term", "Second Term", "Third Term"];
  const terms = [...byTerm.keys()].sort((a, b) => {
    const ai = termOrder.indexOf(a), bi = termOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (terms.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9.5);
    doc.setTextColor(...PDF_BRAND_GRAY);
    doc.text("No scores published for this student yet.", PDF_MARGIN, y + 6);
  } else {
    const pageHeight = doc.internal.pageSize.getHeight();
    terms.forEach((termLabel, i) => {
      if (i > 0 && y > pageHeight - 160) {
        doc.addPage();
        y = 50;
      }
      y = drawReportTermSection(doc, y, termLabel, byTerm.get(termLabel));
    });
  }

  savePdf(doc, `report-card-${pdfSafeName(profile.school_id || profile.full_name)}-full.pdf`);
}
