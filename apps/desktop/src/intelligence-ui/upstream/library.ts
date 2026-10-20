import { Metric, ReviewTable, TaskFiles } from '../task-components.jsx';
import { ResearchSummary, ResearchSection, ResearchNote, KeyValue, Comparison, Sources, ActionBar } from '../research-components.jsx';
import { createLibrary } from "@openuidev/react-lang";
import { actions } from "./actions";
import { functions } from "./functions";
import "./components/theme.css";
import "./components/components.css";
import "./components/map/map.css";
import { Chart } from "./components/chart";
import { Carousel, Celebration, Code, Flashcard, MathBlock, Popover, Quote, YouTube } from "./components/extra";
import {
  Button,
  Checkbox,
  DatePicker,
  IconButton,
  Input,
  Pressable,
  RadioGroup,
  SegmentedControl,
  Select,
  Slider,
  TextArea,
  Timer,
} from "./components/controls";
import { HtmlView } from "./components/html-view";
import { Box, Card, Col, Divider, Form, Grid, Row, Spacer } from "./components/layout";
import { MapMarker, MapView } from "./components/map/map";
import { Icon, Image, SearchImage } from "./components/media";
import { svgComponents } from "./components/svg";
import { Table } from "./components/table";
import { Badge, Caption, Label, Link, List, ListItem, Markdown, Text, Title } from "./components/text";

/**
 * Primitives the model arranges itself, plus a few widgets for what a model
 * cannot draw (a street map, a sandboxed HTML page). Layout is never fixed here.
 * Generic @functions let a page compute with its own state, so an answer can be
 * a working tool rather than a form sent back to the assistant.
 */
export const library = createLibrary({
  root: "Col",
  components: [
    Col, Row, Box, Grid, Card, Carousel, Popover, Divider, Spacer,
    Title, Text, Caption, Label, Badge, Link, List, ListItem, Markdown, Quote, Code, MathBlock,
    Button, IconButton, Pressable, Input, TextArea, Select, SegmentedControl, Slider, Checkbox, RadioGroup, DatePicker, Timer, Form,
    SearchImage, Image, Icon, Table, Chart, MapView, MapMarker, YouTube,
    Flashcard, Celebration, Metric, ReviewTable, TaskFiles,
    ResearchSummary, ResearchSection, ResearchNote, KeyValue, Comparison, Sources, ActionBar,
    ...svgComponents, HtmlView,
  ],
  functions,
  actions,
  componentGroups: [
    { name: "Research composition", components: ["ResearchSummary", "ResearchSection", "ResearchNote", "KeyValue", "Comparison", "Sources", "ActionBar"], notes: [
      '- Start with ResearchSummary(conclusion, explanation, category), then a responsive Metric grid with context, evidence in ResearchSection, inputs and one ActionBar, and Sources. Omit blocks the task does not need.',
      '- Sources and timestamps must be real; never fabricate a comparison. Use ResearchNote to disclose missing context. Keep original amounts and distinguish draft calculations from confirmed execution.',
      '- The host provides the single outer card and document title. Use task-specific titles and labels; never add design-system names such as Research as decoration. Avoid decorative nested Cards and repeated titles. Do not repeat identical records in both KeyValue and ReviewTable.',
    ] },
    { name: "Task review", components: ["Metric", "ReviewTable", "TaskFiles"], notes: [
      '- The host already displays document.title. Use Title for useful section headings rather than repeating that title.',
      '- Visual style: white reading area, shared sans-serif headings and body, quiet separators, 16–18px section gaps, right-aligned exact amounts. Avoid nested decorative Cards.',
      '- Use Metric in Grid(...,4,130) for responsive summaries; use ReviewTable for editable rows and exact business amounts.',
      '- ImportFiles opens the task file picker; ContinueTask retries only a known pending handoff. ToAssistant is the single confirmation path.',
    ] },
    {
      name: "Layout",
      components: ["Col", "Row", "Box", "Grid", "Card", "Carousel", "Popover", "Divider", "Spacer"],
      notes: [
        '- gap and padding count 4px steps. Length is px or a CSS length like "50%". Radius is "sm", "md", "lg", "xl", "full" or px.',
        '- Color is "ink", "muted", "faint", "surface", "info", "success", "warning", "danger", "purple", "pink", "chart1" to "chart6", or a CSS color. As a background, status colors are soft tints.',
      ],
    },
    { name: "Text", components: ["Title", "Text", "Caption", "Label", "Badge", "Link", "List", "ListItem", "Markdown", "Quote", "Code", "Math"] },
    {
      name: "Inputs",
      components: ["Button", "IconButton", "Pressable", "Input", "TextArea", "Select", "SegmentedControl", "Slider", "Checkbox", "RadioGroup", "DatePicker", "Timer", "Form"],
      notes: [
        "- An input's first argument is its value, usually a $variable that other statements read.",
        '- Every input either changes something shown on the page, or sits in a Form whose submit Button sends a short first-person @ToAssistant ("Help me choose a bike"); the form values go with it. No dead inputs.',
      ],
    },
    { name: "Media and data", components: ["SearchImage", "Image", "Icon", "Table", "Chart", "Map", "MapMarker", "YouTube"] },
    { name: "Play", components: ["Flashcard", "Celebration"] },
    { name: "Drawing", components: ["Svg", "G", "Circle", "Ellipse", "Rect", "Line", "Path", "Polyline", "Polygon", "SvgText", "HtmlView"] },
  ],
});

// The CLI (npm run prompt) picks up these exports by name.
// Turnsu generates the same library reference for the original host Agent.
// The upstream demo chat and demo Query data are deliberately not runtime dependencies.
