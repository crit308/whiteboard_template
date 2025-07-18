import { useEffect, useState, useRef, useCallback } from "react";
import { useQuery, useAction, useMutation } from "convex/react";

const insertSnapshot = useMutation(api.database.whiteboard.insertSnapshot); 